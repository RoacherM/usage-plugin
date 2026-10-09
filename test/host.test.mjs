import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { aggregate, resolveRange, zoneOffset } from '../src/host/aggregate.js';
import { decodeFrames, scanSessionLogs } from '../src/host/backfill.js';
import { createLedger } from '../src/host/ledger.js';
import { observeStream } from '../src/host/recorder.js';
import { createSessionFold, usageFields } from '../src/host/records.js';

const tmp = () => mkdtemp(join(tmpdir(), 'dsh-usage-'));
const flushTimers = () => new Promise((r) => setTimeout(r, 450));

async function* chunks(list, { failAt } = {}) {
  for (let i = 0; i < list.length; i++) {
    if (i === failAt) throw Object.assign(new Error('boom'), { code: 'NETWORK' });
    await new Promise((r) => setImmediate(r));
    yield list[i];
  }
}

test('usageFields: cache reads and writes are separate from uncached input', () => {
  assert.deepEqual(usageFields({ inputTokens: 2, outputTokens: 48, totalTokens: 20449, cacheReadTokens: 16320, cacheWriteTokens: 4079 }),
    { in: 2, out: 48, cr: 16320, cw: 4079, rs: 0, tot: 20449 });
  assert.equal(usageFields({ inputTokens: 10, outputTokens: 5 }).tot, 15);
  assert.equal(usageFields(undefined).tot, 0);
});

test('observeStream passes every chunk through and records usage, first token and finish', async () => {
  let clock = 1000;
  const records = [];
  const list = [
    { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } }, { type: 'finish', reason: { kind: 'stop' } },
  ];
  const now = () => (clock += 50);
  const seen = [];
  for await (const chunk of observeStream({ provider: 'deepseek', model: 'deepseek-chat', sessionId: 's1' }, chunks(list), (r) => records.push(r), now)) seen.push(chunk);
  assert.deepEqual(seen, list);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.p, 'deepseek'); assert.equal(r.m, 'deepseek-chat'); assert.equal(r.s, 's1'); assert.equal(r.pu, 'chat');
  assert.equal(r.in, 100); assert.equal(r.cr, 900); assert.equal(r.out, 20); assert.equal(r.tot, 1020); assert.equal(r.f, 'stop');
  assert.equal(r.ft, 50); assert.ok(r.d > r.ft);
});

test('observeStream records thrown errors, provider failures and early stops', async () => {
  const records = [];
  await assert.rejects(async () => { for await (const _ of observeStream({ provider: 'p', model: 'm' }, chunks([{ type: 'block-start' }, {}], { failAt: 1 }), (r) => records.push(r))); }, /boom/);
  assert.equal(records[0].f, 'error'); assert.equal(records[0].e, 'NETWORK'); assert.equal(records[0].pu, 'other');

  for await (const _ of observeStream({ provider: 'p', model: 'm', purpose: 'compaction' }, chunks([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'x' } } }]), (r) => records.push(r)));
  assert.equal(records[1].f, 'error'); assert.equal(records[1].e, 'RATE_LIMIT'); assert.equal(records[1].pu, 'compaction');

  for await (const _ of observeStream({ provider: 'p', model: 'm' }, chunks([{ type: 'text-delta' }, { type: 'text-delta' }]), (r) => records.push(r))) break;
  assert.equal(records[2].f, 'aborted');
});

test('session fold pairs tool calls with results, including failures', () => {
  const tools = [];
  const fold = createSessionFold('s1', { emitTool: (r) => tools.push(r) });
  fold({ type: 'tool/call', time: 100, data: { callId: 'a', name: 'bash' } });
  fold({ type: 'tool/call', time: 110, data: { callId: 'b', name: 'edit' } });
  fold({ type: 'tool/result', time: 400, data: { message: { toolCallId: 'a' } } });
  fold({ type: 'tool/result', time: 130, data: { message: { toolCallId: 'b', isError: true }, error: { code: 'FS_STALE_VERSION' } } });
  assert.deepEqual(tools, [
    { t: 100, s: 's1', n: 'bash', d: 300 },
    { t: 110, s: 's1', n: 'edit', err: 1, code: 'FS_STALE_VERSION', d: 20 },
  ]);
});

test('decodeFrames reads every appended zstd frame', () => {
  const a = zstdCompressSync(Buffer.from('{"type":"session","id":"x"}\n'));
  const b = zstdCompressSync(Buffer.from('{"type":"turn/start","time":1}\n'.repeat(50)));
  const text = decodeFrames(Buffer.concat([a, b]));
  assert.equal(text.split('\n').filter(Boolean).length, 51);
});

async function writeLog(root, workspace, id, events, { version = 4 } = {}) {
  const dir = join(root, workspace, id);
  await mkdir(dir, { recursive: true });
  // Written the way DSH does: one frame per flush.
  const frames = events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')));
  await writeFile(join(dir, `session.v${version}.jsonl.zstd`), Buffer.concat(frames));
}

const assistant = (seq, time, id, model, usage, extra = {}) => ({
  type: 'assistant/message', seq, time,
  data: { turn: 1, step: 1, message: { id, role: 'assistant', content: [], source: { kind: 'model', provider: 'magpie', model } }, usage, stream: [{ type: 'chunk', time: time - 400, chunk: { type: 'block-start' } }], ...extra },
});

test('scanSessionLogs imports calls, tools, titles and errors before the cutoff, deduplicated', async () => {
  const root = await tmp();
  const events = [
    { type: 'session', id: 's-a', cwd: '/w', createdAt: 1 },
    { type: 'session/title', seq: 1, time: 5, data: { title: '写插件' } },
    { type: 'request/context', seq: 2, time: 9, data: { provider: 'magpie', model: 'claude/opus' } },
    { type: 'step/start', seq: 3, time: 1000, data: { turn: 1, step: 1 } },
    assistant(4, 3000, 'm1', 'claude/opus', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 }),
    { type: 'tool/call', seq: 5, time: 3001, data: { callId: 'c1', name: 'bash' } },
    { type: 'tool/result', seq: 6, time: 3500, data: { message: { toolCallId: 'c1' } } },
    { type: 'step/start', seq: 7, time: 3600, data: { turn: 1, step: 2 } },
    { type: 'turn/end', seq: 8, time: 4000, data: { turn: 1, reason: { kind: 'error', error: { code: 'INVALID_REQUEST', message: 'x' } } } },
    { type: 'step/start', seq: 9, time: 9000, data: { turn: 2, step: 1 } },
    assistant(10, 9500, 'm-late', 'claude/opus', { inputTokens: 1, outputTokens: 1 }),
  ];
  await writeLog(root, 'ws', 's-a', events);
  // An older format of the same session is ignored; a fork repeats m1 and must not double count.
  await writeLog(root, 'ws', 's-a', events.slice(0, 3), { version: 3 });
  await writeLog(root, 'ws', 's-fork', [{ type: 'session', id: 's-fork', parentSession: 's-a', origin: 'subagent' }, assistant(1, 3000, 'm1', 'claude/opus', { inputTokens: 10 })]);

  const scan = await scanSessionLogs({ root, before: 5000 });
  assert.equal(scan.files, 2);
  assert.equal(scan.calls.length, 2, 'm1 once + the failed request; m-late is after the cutoff');
  const ok = scan.calls.find((c) => c.f !== 'error');
  assert.deepEqual({ t: ok.t, d: ok.d, ft: ok.ft, m: ok.m, s: ok.s, tot: ok.tot, src: ok.src }, { t: 1000, d: 2000, ft: 1600, m: 'claude/opus', s: 's-a', tot: 115, src: 'log' });
  const failed = scan.calls.find((c) => c.f === 'error');
  assert.equal(failed.e, 'INVALID_REQUEST'); assert.equal(failed.m, 'claude/opus'); assert.equal(failed.t, 3600);
  assert.deepEqual(scan.tools, [{ t: 3001, s: 's-a', n: 'bash', d: 499 }]);
  assert.equal(scan.sessions['s-a'].title, '写插件');
  assert.equal(scan.sessions['s-fork'].origin, 'subagent');
  await rm(root, { recursive: true });
});

test('ledger persists live records by month, survives reload, and holds records that arrive while loading', async () => {
  const dir = await tmp();
  const ledger = createLedger({ dir });
  ledger.addCall({ t: Date.UTC(2026, 8, 1), p: 'p', m: 'm', tot: 1 }); // before load finishes
  await ledger.load();
  ledger.addCall({ t: Date.UTC(2026, 9, 1), p: 'p', m: 'm', tot: 2 });
  ledger.addTool({ t: Date.UTC(2026, 9, 1), n: 'bash' });
  ledger.noteSession('s1', { title: 'hello', cwd: '/w' });
  await ledger.flush();
  assert.equal(ledger.cutoff, Date.UTC(2026, 8, 1));
  assert.match(await readFile(join(dir, 'calls-2026-09.jsonl'), 'utf8'), /"tot":1/);
  assert.match(await readFile(join(dir, 'calls-2026-10.jsonl'), 'utf8'), /"tot":2/);

  const again = await createLedger({ dir }).load();
  assert.equal(again.calls().length, 2);
  assert.equal(again.tools().length, 1);
  assert.equal(again.sessions().s1.title, 'hello');
  await again.replaceHistory({ calls: [{ t: 1, p: 'p', m: 'old', tot: 9, src: 'log' }], tools: [], files: 3, sessions: { s1: { title: 'stale' }, s2: { title: 'old' } } });
  assert.equal(again.calls().length, 3);
  assert.equal(again.sessions().s1.title, 'hello', 'a live title wins over an imported one');
  assert.equal(again.sessions().s2.title, 'old');
  assert.equal((await createLedger({ dir }).load()).history().calls, 1);
  await rm(dir, { recursive: true });
});

test('ranges and buckets follow the viewer time zone', () => {
  const offset = zoneOffset('Asia/Shanghai');
  const now = Date.UTC(2026, 8, 28, 10, 0); // 18:00 in Shanghai
  const today = resolveRange('today', { now, offset });
  assert.equal(today.from, Date.UTC(2026, 8, 27, 16, 0)); // local midnight
  assert.equal(today.bucket, 'hour');
  const week = resolveRange('7d', { now, offset });
  assert.equal(week.from, Date.UTC(2026, 8, 21, 16, 0));
  assert.equal(week.prevFrom, week.from - (now - week.from));
  assert.equal(resolveRange('all', { now, offset, earliest: now - 400 * 86_400_000 }).bucket, 'week');
});

test('aggregate: totals, per-model rows, series, previous period and model filter', () => {
  const H = 3_600_000;
  const now = Date.UTC(2026, 8, 28, 10, 0);
  const call = (t, m, extra = {}) => ({ t, p: 'magpie', m, s: 's1', pu: 'chat', in: 100, out: 50, cr: 900, cw: 0, rs: 0, tot: 1050, f: 'stop', d: 2000, ft: 500, src: 'live', ...extra });
  const calls = [
    call(now - 1 * H, 'claude/opus'),
    call(now - 2 * H, 'claude/opus', { f: 'error', e: 'RATE_LIMIT', in: 0, out: 0, cr: 0, tot: 0, d: 100 }),
    call(now - 3 * H, 'deepseek-chat', { s: 's2' }),
    call(now - 30 * H, 'deepseek-chat'), // yesterday: previous period for "today"
  ];
  const tools = [{ t: now - H, s: 's1', n: 'bash', d: 100 }, { t: now - H, s: 's1', n: 'bash', err: 1, code: 'X' }, { t: now - 3 * H, s: 's2', n: 'read' }];
  const r = aggregate({ calls, tools, sessions: { s1: { title: '标题' } }, range: 'today', timeZone: 'Asia/Shanghai', now });
  assert.equal(r.totals.calls, 3);
  assert.equal(r.totals.errors, 1);
  assert.equal(r.totals.tot, 2100);
  assert.equal(r.totals.cacheRate, 1800 / 2000);
  assert.equal(r.totals.avgMs, 2000, 'failed calls do not count toward latency');
  assert.equal(r.previous.calls, 1);
  assert.equal(r.models[0].model, 'claude/opus');
  assert.equal(r.models[0].errors, 1);
  assert.equal(r.totals.toolCalls, 3);
  assert.equal(r.totals.toolErrors, 1);
  assert.equal(r.totals.cost, undefined, 'no cost fields');
  assert.equal(r.series.rows.length, 19, 'hourly buckets from local midnight to 18:00');
  assert.equal(r.series.rows.reduce((a, row) => a + row.calls.reduce((x, y) => x + y, 0), 0), 3);
  assert.equal(r.tools[0].name, 'bash'); assert.equal(r.tools[0].errors, 1); assert.equal(r.tools[0].topError, 'X');
  assert.equal(r.sessions.find((x) => x.id === 's1').title, '标题');
  assert.equal(r.recent[0].t, now - H);
  assert.equal(r.hours[17].calls, 1); // 17:00 Shanghai

  assert.equal(r.totals.modelMs, 2000 + 100 + 2000, 'only calls inside today');
  assert.equal(r.activity.tot.length % 7, 1, 'weeks from a Monday through today (a Monday here)');
  assert.equal(r.activity.tot.at(-1), 2100);
  assert.equal(r.activity.tot.at(-2), 1050, 'yesterday is on the board even though it is outside the range');
  assert.deepEqual(r.notes, []);

  const only = aggregate({ calls, tools, range: 'today', timeZone: 'Asia/Shanghai', now, filter: 'magpie|deepseek-chat' });
  assert.equal(only.totals.calls, 1);
  assert.deepEqual(only.tools.map((x) => x.name), ['read'], 'tools are limited to the sessions that used the model');
});

test('aggregate: speed, context growth, working time and plain-language notes', () => {
  const now = Date.UTC(2026, 8, 28, 10, 0);
  const M = 60_000;
  const call = (t, extra = {}) => ({ t, p: 'p', m: 'm', s: 'big', pu: 'chat', in: 10, out: 1000, cr: 0, cw: 0, tot: 0, f: 'stop', d: 6000, ft: 1000, ...extra });
  const calls = [
    call(now - 60 * M, { cr: 20_000 }),
    call(now - 50 * M, { cr: 300_000 }),
    // 20 idle minutes later the cache is gone: the whole context is written again.
    call(now - 29 * M, { cw: 450_000 }),
    call(now - 28 * M, { cr: 450_000, ft: 3000 }),
  ].map((c) => ({ ...c, tot: c.in + c.out + c.cr + c.cw }));
  const tools = [
    ...Array.from({ length: 6 }, (_, i) => ({ t: now - 40 * M + i, s: 'big', n: 'edit', err: 1, code: 'FS_STALE_VERSION', d: 10 })),
    { t: now - 30 * M, s: 'big', n: 'ask_user_question', d: 600_000 },
  ];
  const r = aggregate({ calls, tools, sessions: { big: { title: '长任务' } }, range: 'today', timeZone: 'UTC', now });
  const model = r.models[0];
  assert.equal(model.speed, 222, '4000 output tokens over 5 + 5 + 5 + 3 s after the first token');
  assert.equal(model.ttftMed, 1000);
  assert.deepEqual([r.sessions[0].ctxFirst, r.sessions[0].ctxPeak], [20_010, 450_010]);
  assert.deepEqual([r.totals.modelMs, r.totals.toolMs, r.totals.waitMs], [24_000, 60, 600_000]);
  assert.deepEqual(r.notes.map((n) => n.kind), ['context', 'cacheIdle', 'toolFail']);
  assert.equal(r.notes[0].title, '长任务');
  assert.equal(r.notes[1].calls, 1); assert.equal(r.notes[1].tokens, 450_000);
  assert.deepEqual([r.notes[2].tool, r.notes[2].code, r.notes[2].count], ['edit', 'FS_STALE_VERSION', 6]);
});

test('apply(): routes, live recording, history import and the usage_report tool work together', async () => {
  const dataDir = await tmp();
  const sessionsDir = await tmp();
  await writeLog(sessionsDir, 'ws', 's-old', [
    { type: 'session', id: 's-old', cwd: '/w' },
    { type: 'session/title', seq: 1, time: 5, data: { title: '旧会话' } },
    { type: 'step/start', seq: 2, time: Date.now() - 86_400_000, data: {} },
    assistant(3, Date.now() - 86_400_000 + 1000, 'm-old', 'claude/opus', { inputTokens: 7, outputTokens: 3 }),
  ]);
  const routes = new Map();
  const listeners = {};
  const tools = new Map();
  const ctx = {
    effect: (fn) => fn(),
    on: (name, fn) => { listeners[name] = fn; },
    connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } },
    tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
    logger: { warn: () => {} },
  };
  const { apply } = await import('../src/host/index.js');
  apply(ctx, { dataDir, sessionsDir });
  assert.ok(listeners['llm/stream'] && listeners['session/event']);
  assert.ok(routes.has('/api/usage/summary') && !routes.has('/api/usage/prices') && tools.has('usage_report'));

  const get = async (path) => (await routes.get(new URL(path, 'http://x').pathname).fetch(new Request('http://x' + path))).json();
  // Wait for the first-start history import.
  for (let i = 0; i < 50 && !(await get('/api/usage/summary?range=all')).history.importedAt; i++) await new Promise((r) => setTimeout(r, 20));

  const stream = listeners['llm/stream']({ provider: 'deepseek', model: 'deepseek-chat', sessionId: 's-new' }, () => chunks([
    { type: 'text-delta' }, { type: 'usage', usage: { inputTokens: 40, outputTokens: 2 } }, { type: 'finish', reason: { kind: 'stop' } },
  ]));
  for await (const _ of stream);
  listeners['session/event']({ id: 's-new', header: { cwd: '/w' } }, { type: 'session/title', time: 1, data: { title: '新会话' } });
  listeners['session/event']({ id: 's-new' }, { type: 'tool/call', time: 10, data: { callId: 'c', name: 'grep' } });
  listeners['session/event']({ id: 's-new' }, { type: 'tool/result', time: 20, data: { message: { toolCallId: 'c' } } });

  const summary = await get('/api/usage/summary?range=7d&tz=Asia/Shanghai');
  assert.equal(summary.totals.calls, 2);
  assert.deepEqual(summary.models.map((m) => m.model).sort(), ['claude/opus', 'deepseek-chat']);
  assert.equal(summary.history.calls, 1);
  assert.deepEqual(summary.sessions.map((s) => s.title).sort(), ['新会话', '旧会话']);


  const wait = routes.get('/api/usage/wait').fetch(new Request(`http://x/api/usage/wait?revision=${summary.revision}`));
  listeners['session/event']({ id: 's-new' }, { type: 'session/title', time: 2, data: { title: '改名' } });
  assert.ok((await (await wait).json()).revision > summary.revision);

  const report = await tools.get('usage_report').execute({ range: 'all' }, {});
  assert.match(report.text, /Model calls: 2/);
  assert.match(report.text, /deepseek-chat/);
  assert.doesNotMatch(report.text, /cost|price/i);
  assert.match(report.text, /agent working time/);
  await flushTimers();
  await rm(dataDir, { recursive: true });
  await rm(sessionsDir, { recursive: true });
});
