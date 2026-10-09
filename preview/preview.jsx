// Design preview: the real dashboard against a snapshot of the local ledger, for headless-Chrome screenshots.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { aggregate } from '../src/host/aggregate.js';
import { makeUsagePage } from '../src/client/page.jsx';
import { CSS } from '../src/client/styles.js';
import DATA from './data.json';

const params = new URLSearchParams(location.search);
window.fetch = async (url) => {
  const u = new URL(url, location.href);
  const ok = (v) => new Response(JSON.stringify(v));
  if (u.pathname.endsWith('/wait')) return new Promise(() => {});
  if (u.pathname.endsWith('/summary')) {
    const q = u.searchParams;
    return ok({ ...aggregate({ ...DATA, range: q.get('range'), timeZone: q.get('tz'), filter: q.get('model') || undefined, now: DATA.at }), history: DATA.history, cutoff: DATA.cutoff, revision: 1 });
  }
  return ok({});
};
if (params.get('range')) localStorage.setItem('dsh-usage:range', params.get('range'));
const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);
if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
const locale = { getSnapshot: () => ({ active: params.get('lang') ?? 'zh-CN' }), subscribe: () => () => {} };
const Page = makeUsagePage({ openSession: () => {}, locale });
createRoot(document.getElementById('root')).render(<Page />);

// ?measure: after render, write layout facts into the DOM for `--dump-dom` checks.
if (params.has('measure')) setTimeout(() => {
  const inner = document.querySelector('.us-inner').getBoundingClientRect();
  const out = { width: inner.width, overflow: [], truncated: [], sections: [] };
  for (const el of document.querySelectorAll('.us-inner *')) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > inner.right + 11 || r.left < inner.left - 11)) out.overflow.push(`${el.tagName}.${el.className?.baseVal ?? el.className} ${Math.round(r.left)}-${Math.round(r.right)}`);
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis') out.truncated.push(el.textContent.slice(0, 50));
  }
  for (const el of document.querySelectorAll('.us-hero, .us-chart, .us-section, .us-foot, .us-top')) { const r = el.getBoundingClientRect(); out.sections.push(`${el.className} y=${Math.round(r.top)} h=${Math.round(r.height)}`); }
  out.hero = document.querySelector('.us-hero')?.innerText.replace(/\n/g, ' | ');
  out.rows = [...document.querySelectorAll('.us-row')].slice(0, 6).map((r) => r.innerText.replace(/\n/g, ' | '));
  out.bars = document.querySelectorAll('.us-chart svg rect[style]').length;
  out.cells = document.querySelectorAll('.us-cell').length; out.filled = document.querySelectorAll('.us-cell:not(.empty)').length;
  out.board = document.querySelector('.us-board svg')?.getAttribute('width');
  out.notes = [...document.querySelectorAll('.us-notes li')].map((l) => l.innerText.replace(/\n/g, ' / '));
  out.months = [...document.querySelectorAll('.us-board text')].map((x) => x.textContent).join(' ');
  const pre = document.createElement('pre'); pre.id = 'measure'; pre.textContent = JSON.stringify(out, null, 1); document.body.appendChild(pre);
}, 600);
