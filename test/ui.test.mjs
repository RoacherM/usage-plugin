import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { aggregate } from '../src/host/aggregate.js';

const require = createRequire(import.meta.url);

/** Load the built client.js the way DSH's module loader does, against a fake Client ctx. */
async function loadClient(fetchImpl) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:19387/', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = fetchImpl;
  window.fetch = fetchImpl;
  let loaded;
  window.__ModuleLoader__ = { load: ({ factory }) => { loaded = factory((name) => require(name)); } };
  new Function(await readFile(new URL('../client.js', import.meta.url), 'utf8'))();
  const registrations = [];
  const calls = [];
  const listeners = new Set();
  let snap = { active: 'zh-CN' };
  const locale = {
    register: () => () => {}, bind: () => (key) => ({ panel: '用量' })[key] ?? key,
    getSnapshot: () => snap, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set(active) { snap = { active }; for (const fn of listeners) fn(); },
  };
  const ctx = {
    effect: (fn) => fn(),
    get: (name) => ({
      layout: { selectPanel: (id) => calls.push(['selectPanel', id]) },
      uiWorkspace: { openSession: (id) => calls.push(['openSession', id]) },
    })[name],
    locale,
    slots: { inject: (name, cb) => cb(), register: (meta, Component) => { registrations.push({ meta, Component }); return () => {}; } },
  };
  loaded.apply(ctx);
  return { registrations, calls, locale, inject: loaded.inject };
}

const H = 3_600_000;
const NOW = Date.now();
const call = (t, m, extra = {}) => ({ t, p: 'magpie', m, s: 's1', pu: 'chat', in: 1200, out: 300, cr: 50_000, cw: 800, rs: 40, tot: 52_300, f: 'stop', d: 4200, ft: 900, src: 'live', ...extra });
const CALLS = [
  call(NOW - 1 * H, 'claude/claude-opus-5-5'),
  call(NOW - 2 * H, 'claude/claude-opus-5-5', { f: 'error', e: 'RATE_LIMIT', in: 0, out: 0, cr: 0, cw: 0, tot: 0 }),
  call(NOW - 26 * H, 'deepseek-chat', { p: 'deepseek', s: 's2', pu: 'compaction' }),
];
const TOOLS = [{ t: NOW - H, s: 's1', n: 'bash', d: 800 }, { t: NOW - H, s: 's1', n: 'edit', err: 1, code: 'FS_STALE_VERSION' }];
const SESSIONS = { s1: { title: '实现用量插件', cwd: '/w' }, s2: { title: '子任务', origin: 'subagent' } };

function summary(range, model) {
  return {
    ...aggregate({ calls: CALLS, tools: TOOLS, sessions: SESSIONS, range, timeZone: 'Asia/Shanghai', filter: model || undefined }),
    history: { importedAt: NOW - H, files: 12, calls: 1, tools: 0 }, cutoff: NOW - 3 * H, revision: 1,
  };
}

const settle = async (act) => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };

test('usage client registers the sidebar entry and renders the dashboard', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    requests.push([init.method ?? 'GET', u.pathname, Object.fromEntries(u.searchParams), init.body ? JSON.parse(init.body) : undefined]);
    const ok = (value) => new Response(JSON.stringify(value), { status: 200 });
    if (u.pathname.endsWith('/summary')) return ok(summary(u.searchParams.get('range'), u.searchParams.get('model')));
    if (u.pathname.endsWith('/wait')) return u.searchParams.get('revision') === '-1' ? ok({ revision: 1 }) : new Promise(() => {});
    return new Response('{}', { status: 404 });
  };
  const { registrations, calls, locale, inject } = await loadClient(fetchImpl);
  assert.deepEqual(inject, ['slots', 'locale']);
  const panel = registrations.find((r) => r.meta.name === 'sidebar.panellist');
  assert.equal(panel.meta.id, 'local-usage');
  assert.equal(panel.meta.label(), '用量');
  const page = registrations.find((r) => r.meta.name === 'main');
  assert.equal(page.meta.key, 'local-usage');

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(page.Component)));
  await settle(act);

  const text = () => document.body.textContent;
  const range = requests.find((r) => r[1].endsWith('/summary'))[2];
  assert.equal(range.range, '7d');
  assert.ok(range.tz);
  for (const expected of ['最近 7 天消耗的 Token', '次模型调用', '缓存命中', '次工具调用', '次失败', '模型', 'claude-opus-5-5', 'deepseek-chat', '实现用量插件', '子代理']) {
    assert.ok(text().includes(expected), `page shows ${expected}`);
  }
  assert.equal(document.querySelector('.us-hero-num b').textContent, '105K', 'total tokens of the two successful calls');
  assert.match(document.querySelector('.us-fact.err').title, /RATE_LIMIT ×1/);
  assert.ok(document.querySelector('.us-chart svg rect[style]'), 'the trend chart draws bars');
  assert.match(text(), /1 次调用从 12 个会话日志导入/);
  assert.ok(!/价格|费用/.test(text()), 'nothing about prices');
  assert.equal(document.querySelectorAll('input, table').length, 0, 'no forms, no tables');

  // The activity board: a year of days, the switch changes how cells are shaded.
  assert.ok(document.querySelectorAll('.us-cell').length >= 365);
  assert.ok(document.querySelectorAll('.us-cell:not(.empty)').length >= 1);
  const boardTab = (label) => [...document.querySelectorAll('.us-switch button')].find((b) => b.textContent === label);
  await act(async () => boardTab('累计').click());
  assert.equal(boardTab('累计').getAttribute('aria-selected'), 'true');
  assert.ok(text().includes('Agent 工作时长'));

  // One list at a time: sessions by default, then tools, then recent calls.
  const tab = (label) => [...document.querySelectorAll('.us-tabs button')].find((b) => b.textContent.startsWith(label));
  assert.equal(tab('会话').getAttribute('aria-selected'), 'true');
  assert.ok(!text().includes('FS_STALE_VERSION'));
  await act(async () => tab('工具').click());
  assert.match(text(), /bash/); assert.match(text(), /1 次失败 · FS_STALE_VERSION/);
  await act(async () => tab('最近调用').click());
  assert.match(text(), /失败 · RATE_LIMIT/); assert.ok(text().includes('压缩'));
  await act(async () => tab('会话').click());

  // Range switch.
  const todayTab = [...document.querySelectorAll('.us-ranges button')].find((b) => b.textContent === '今天');
  await act(async () => todayTab.click());
  await settle(act);
  assert.equal(requests.filter((r) => r[1].endsWith('/summary')).at(-1)[2].range, 'today');
  assert.ok(!text().includes('deepseek-chat'), 'yesterday\'s model is outside today');

  // Clicking a model row filters everything to it; the chip clears it.
  const row = [...document.querySelectorAll('.us-row.click')].find((r) => r.textContent.includes('claude-opus-5-5'));
  await act(async () => row.click());
  await settle(act);
  assert.equal(requests.filter((r) => r[1].endsWith('/summary')).at(-1)[2].model, 'magpie|claude/claude-opus-5-5');
  assert.equal(document.querySelector('.us-chip').textContent, 'claude-opus-5-5');
  await act(async () => document.querySelector('.us-chip').click());
  await settle(act);
  assert.equal(document.querySelector('.us-chip'), null);

  // Opening a session from the list.
  const session = [...document.querySelectorAll('.us-row.click')].find((b) => b.textContent.includes('实现用量插件'));
  await act(async () => session.click());
  assert.deepEqual(calls.slice(-2), [['selectPanel', null], ['openSession', 's1']]);

  // Language follows DSH.
  await act(async () => locale.set('en-US'));
  assert.ok(text().includes('Tokens used today') && text().includes('Sessions'));
  await act(async () => root.unmount());
});
