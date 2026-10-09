/**
 * `usage_report`: lets the agent answer "我这周用了多少 token？" from the same ledger as the page.
 */
import { RANGES, aggregate } from './aggregate.js';

const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The zone of the browser that sent the caller's latest message, else the Host's. */
function callerTimeZone(exec) {
  try {
    const messages = exec?.agent?.session?.deriveMessages?.() ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const zone = messages[i]?.role === 'user' ? messages[i].source?.clientTimeZone : undefined;
      if (zone) { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; }
    }
  } catch { /* fall back */ }
  return hostZone();
}

export const fmtTokens = (n) => {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};
const pct = (x) => (x === undefined ? '—' : (x * 100).toFixed(1) + '%');
const secs = (ms) => (ms === undefined ? '—' : (ms / 1000).toFixed(1) + 's');
const hours = (ms) => (ms / 3_600_000).toFixed(1) + 'h';

function noteText(note) {
  if (note.kind === 'context') return `Session 「${note.title ?? note.session}」 grew its context from ${fmtTokens(note.first)} to ${fmtTokens(note.peak)} tokens over ${note.calls} calls (every call re-reads it)${note.others ? `; ${note.others} more sessions passed 400K` : ''}. Suggest /compact or a fresh session for long tasks.`;
  if (note.kind === 'cacheIdle') return `${note.calls} times the prompt cache expired after >5 idle minutes, re-writing ${fmtTokens(note.tokens)} tokens.`;
  if (note.kind === 'toolFail') return `Tool ${note.tool} failed ${note.count} times${note.code ? ` with ${note.code}` : ''}.`;
  return '';
}

export function renderReport(report, { rangeLabel }) {
  const t = report.totals;
  const lines = [
    `DSH usage — ${rangeLabel} (${report.range.timeZone})`,
    `Model calls: ${t.calls} (errors ${t.errors}, aborted ${t.aborted}) across ${t.sessions} sessions and ${t.models} models`,
    `Tokens: total ${fmtTokens(t.tot)} = uncached input ${fmtTokens(t.in)} + cache read ${fmtTokens(t.cr)} + cache write ${fmtTokens(t.cw)} + output ${fmtTokens(t.out)}${t.rs ? ` (reasoning ${fmtTokens(t.rs)})` : ''}`,
    `Cache hit rate ${pct(t.cacheRate)} · avg latency ${secs(t.avgMs)} (p95 ${secs(t.p95Ms)}) · avg time to first token ${secs(t.avgTtft)}`,
    `Tool calls: ${t.toolCalls} (errors ${t.toolErrors}) · agent working time ${hours(t.modelMs + t.toolMs)} (model ${hours(t.modelMs)}, tools ${hours(t.toolMs)}; plus ${hours(t.waitMs)} waiting for the user)`,
    '',
    '| provider | model | calls | errors | input | cache read | output | total | avg latency | speed | first token |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.models.map((m) => `| ${m.provider} | ${m.model} | ${m.calls} | ${m.errors} | ${fmtTokens(m.in + m.cw)} | ${fmtTokens(m.cr)} | ${fmtTokens(m.out)} | ${fmtTokens(m.tot)} | ${secs(m.avgMs)} | ${m.speed ? m.speed + ' tok/s' : '—'} | ${secs(m.ttftMed)} |`),
  ];
  if (report.notes?.length) lines.push('', 'Worth knowing:', ...report.notes.map((note) => '- ' + noteText(note)));
  if (report.tools.length) {
    lines.push('', 'Top tools: ' + report.tools.slice(0, 10).map((x) => `${x.name} ${x.calls}${x.errors ? ` (${x.errors} failed)` : ''}`).join(', '));
  }
  if (report.sessions.length) {
    lines.push('', 'Top sessions by tokens: ' + report.sessions.slice(0, 5).map((s) => `「${s.title ?? s.id}」 ${fmtTokens(s.tot)}`).join('; '));
  }
  if (report.errorCodes.length) {
    lines.push('', 'Model errors: ' + report.errorCodes.map((e) => `${e.code} ×${e.count}`).join(', '));
  }
  return lines.join('\n');
}

const LABEL = { today: 'today', '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days', all: 'all time' };

export function registerTools(ctx, { ledger }) {
  ctx.effect(() => ctx.tools.register({
    name: 'usage_report',
    description: [
      'Report DSH model usage from the local usage ledger: tokens (uncached input, cache read/write, output, reasoning), call counts, errors, latency, output speed and cache hit rate per model, agent working time, notes on context growth / cache expiry / repeated tool failures, plus top tools and sessions.',
      'Use it when the user asks how many tokens / calls they have used, which model they use most, cache hit rate, etc. Present the numbers concisely in the user\'s language and mention they can see charts on the "用量" (Usage) page in the left sidebar.',
    ].join('\n'),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        range: { type: 'string', enum: RANGES, description: 'Time range in the user\'s time zone: today, 7d, 30d, 90d, or all. Default 7d.' },
        model: { type: 'string', description: 'Optional: limit to one model id (e.g. "deepseek-chat"); matched against the model name, any provider.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const range = RANGES.includes(args?.range) ? args.range : '7d';
      let calls = ledger.calls();
      if (args?.model) calls = calls.filter((c) => c.m === args.model || c.m.endsWith('/' + args.model) || `${c.p}|${c.m}` === args.model);
      const report = aggregate({ calls, tools: ledger.tools(), sessions: ledger.sessions(), range, timeZone: callerTimeZone(exec) });
      return { text: renderReport(report, { rangeLabel: LABEL[range] + (args?.model ? ` · model ${args.model}` : '') }) };
    },
  }), 'dsh-usage: usage_report');
}
