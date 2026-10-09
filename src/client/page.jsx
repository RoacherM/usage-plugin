/**
 * The usage page reads top to bottom like a statement: one headline number, the few facts that
 * qualify it, the shape over time, where it went (models), then one list at a time (sessions,
 * tools, recent calls). No boxes, no tables, nothing to fill in.
 */
import React from 'react';
import { api } from './api.js';
import { ActivityBoard, TrendChart } from './chart.jsx';
import { count, duration, percent, seriesColor, splitModel, stamp, tokens } from './format.js';
import { useI18n, withI18n } from './i18n.jsx';

const RANGES = ['today', '7d', '30d', '90d', 'all'];

function Svg({ size = 16, children }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
const Icon = {
  x: (p) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>,
  chevron: (p) => <Svg {...p}><path d="m9.5 6 6 6-6 6" /></Svg>,
};

/** Summary for the chosen range, reloaded whenever the Host records something new. */
function useSummary(range, model) {
  const [state, setState] = React.useState({ loading: true, error: null, data: null });
  const reload = React.useCallback(async (signal) => {
    try {
      const data = await api.summary({ range, model }, signal);
      setState({ loading: false, error: null, data });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setState((s) => ({ ...s, loading: false, error: error.message }));
    }
  }, [range, model]);
  React.useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    (async () => {
      await reload(controller.signal);
      let revision = -1;
      while (alive) {
        try {
          const next = await api.wait(revision, controller.signal);
          if (!alive) return;
          if (next.revision !== revision) {
            if (revision !== -1) await reload(controller.signal);
            revision = next.revision;
          }
        } catch {
          if (!alive) return;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [reload]);
  return [state, () => reload()];
}

function Delta({ now, before }) {
  const { t } = useI18n();
  if (!before || !now) return null;
  const change = (now - before) / before;
  // Tiny or huge swings mostly mean the previous period barely had data; say nothing then.
  if (Math.abs(change) < 0.005 || Math.abs(change) > 3) return null;
  return <span className="us-delta" title={t('vsPrev')}>{change > 0 ? '↑' : '↓'} {percent(Math.abs(change), Math.abs(change) >= 10 ? 0 : 1)}</span>;
}

function Fact({ value, label, tone, title }) {
  return <div className={'us-fact' + (tone ? ' ' + tone : '')} title={title}><b>{value}</b><span>{label}</span></div>;
}

function Hero({ data, range }) {
  const { t } = useI18n();
  const tot = data.totals;
  const errors = data.errorCodes.map((e) => `${e.code} ×${e.count}`).join('\n');
  return (
    <section className="us-hero">
      <div className="us-hero-label">{t('heroLabel', { range: t('rangeLong_' + range) })}</div>
      <div className="us-hero-num"><b>{tokens(tot.tot)}</b><Delta now={tot.tot} before={data.previous?.tot} /></div>
      <div className="us-facts">
        <Fact value={count(tot.calls)} label={t('fCalls')} />
        <Fact value={percent(tot.cacheRate)} label={t('fCache')} title={t('fCacheHint', { cr: tokens(tot.cr), all: tokens(tot.in + tot.cr + tot.cw) })} />
        <Fact value={duration(tot.modelMs + tot.toolMs, t)} label={t('fWork')} title={t('fWorkHint', { model: duration(tot.modelMs, t), tools: duration(tot.toolMs, t), wait: duration(tot.waitMs, t) })} />
        <Fact value={duration(tot.avgMs, t)} label={t('fLatency')} title={t('fLatencyHint', { ttft: duration(tot.avgTtft, t), p95: duration(tot.p95Ms, t) })} />
        <Fact value={count(tot.toolCalls)} label={t('fTools')} />
        {tot.errors ? <Fact value={count(tot.errors)} label={t('fErrors')} tone="err" title={errors} /> : null}
      </div>
    </section>
  );
}

/** Plain-language notes; each says what happened and what it cost, only when it is worth acting on. */
function Notes({ notes, openSession }) {
  const { t } = useI18n();
  if (!notes?.length) return null;
  // Known error codes read as words; unknown ones stay as the code.
  const known = (key) => { const text = t(key); return text === key ? undefined : text; };
  const MARK = '\u0001';
  return (
    <ul className="us-notes">
      {notes.map((note) => {
        if (note.kind === 'context') {
          return (
            <li key="context">
              <span>
                {t('noteContext', { session: MARK, first: tokens(note.first), peak: tokens(note.peak), calls: count(note.calls) }).split(MARK).map((part, i) => (
                  <React.Fragment key={i}>{i ? <button type="button" className="us-inline" onClick={() => openSession(note.session)}>{note.title ?? note.session.slice(0, 8)}</button> : null}{part}</React.Fragment>
                ))}
                {note.others ? t('noteContextOthers', { n: note.others }) : ''}
              </span>
              <em>{t('noteContextTip')}</em>
            </li>
          );
        }
        if (note.kind === 'cacheIdle') return <li key="cache"><span>{t('noteCache', { n: note.calls, tokens: tokens(note.tokens), share: percent(note.share, 0) })}</span><em>{t('noteCacheTip')}</em></li>;
        if (note.kind === 'toolFail') {
          const tip = known(`code_${note.code}_tip`);
          return <li key="fail"><span>{t('noteFail', { tool: note.tool, n: note.count, reason: known(`code_${note.code}`) ?? note.code ?? t('unknownReason') })}</span>{tip ? <em>{tip}</em> : null}</li>;
        }
        return null;
      })}
    </ul>
  );
}

/** A list row: leading mark, title over a quiet meta line, value on the right, optional share line. */
function Row({ lead, title, badge, meta, value, sub, share, color, onClick, selected, tone }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={'us-row' + (onClick ? ' click' : '') + (selected ? ' on' : '') + (tone ? ' ' + tone : '')} onClick={onClick}>
      {lead}
      <span className="us-row-main">
        <span className="us-row-title">{title}{badge ? <em className="us-badge">{badge}</em> : null}</span>
        {meta ? <span className="us-row-meta">{meta}</span> : null}
      </span>
      <span className="us-row-value"><b>{value}</b>{sub ? <span>{sub}</span> : null}</span>
      {share !== undefined ? <span className="us-row-share"><i style={{ width: `${Math.max(share * 100, 0.6)}%`, background: color }} /></span> : null}
    </Tag>
  );
}

const joinMeta = (parts) => parts.filter(Boolean).map((part, i) => <React.Fragment key={i}>{i ? <span className="us-dot" /> : null}{part}</React.Fragment>);

function Models({ data, filter, onFilter }) {
  const { t } = useI18n();
  const total = data.totals.tot || 1;
  const colorOf = (key) => { const i = data.series.keys.indexOf(key); return seriesColor(i >= 0 ? key : 'other', Math.max(i, 0)); };
  return (
    <div className="us-list">
      {data.models.map((m) => {
        const { name, route } = splitModel(m.model);
        return (
          <Row key={m.key} onClick={() => onFilter(filter === m.key ? '' : m.key)} selected={filter === m.key}
            lead={<i className="us-mark" style={{ background: colorOf(m.key) }} />}
            title={<><span className="us-strong" title={m.model}>{name}</span><span className="us-route">{[m.provider, route].filter(Boolean).join(' / ')}</span></>}
            meta={joinMeta([
              t('nCalls', { n: count(m.calls) }),
              m.cacheRate !== undefined ? t('hitShort', { p: percent(m.cacheRate, 0) }) : null,
              m.speed !== undefined ? <span title={t('speedHint')}>{t('speed', { n: count(m.speed) })}</span> : null,
              m.ttftMed !== undefined ? t('ttftShort', { d: duration(m.ttftMed, t) }) : null,
              m.errors ? <span className="us-err">{t('nFailed', { n: m.errors })}</span> : null,
            ])}
            value={tokens(m.tot)} sub={m.tot ? percent(m.tot / total, m.tot / total < 0.001 ? 2 : 1) : '—'} share={m.tot / total} color={colorOf(m.key)} />
        );
      })}
    </div>
  );
}

function Sessions({ data, openSession }) {
  const { t } = useI18n();
  if (!data.sessions.length) return <div className="us-quiet us-pad">{t('noSessions')}</div>;
  const max = data.sessions[0].tot || 1;
  return (
    <div className="us-list">
      {data.sessions.slice(0, 12).map((s) => (
        <Row key={s.id} onClick={() => openSession(s.id)}
          title={<span className="us-strong">{s.title ?? s.id}</span>} badge={s.origin === 'subagent' ? t('subagent') : null}
          meta={joinMeta([
            t('nCalls', { n: count(s.calls) }),
            s.ctxPeak ? <span className={s.ctxPeak >= 400_000 ? 'us-warn' : undefined} title={t('ctxHint')}>{t('ctx', { first: tokens(s.ctxFirst), peak: tokens(s.ctxPeak) })}</span> : null,
            s.models.map((m) => splitModel(m).name).join(', '),
          ])}
          value={tokens(s.tot)} sub={<Icon.chevron size={13} />} share={s.tot / max} color="var(--us-soft)" />
      ))}
    </div>
  );
}

function Tools({ data }) {
  const { t } = useI18n();
  if (!data.tools.length) return <div className="us-quiet us-pad">{t('noTools')}</div>;
  const max = data.tools[0].calls || 1;
  return (
    <div className="us-list">
      {data.tools.slice(0, 15).map((tool) => (
        <Row key={tool.name}
          title={<span className="us-mono">{tool.name}</span>}
          meta={joinMeta([
            tool.avgMs !== undefined ? t('avgTime', { d: duration(tool.avgMs, t) }) : null,
            tool.errors ? <span className="us-err">{t('nFailed', { n: tool.errors })}{tool.topError ? ` · ${tool.topError}` : ''}</span> : null,
          ])}
          value={count(tool.calls)} share={tool.calls / max} color="var(--us-soft)" />
      ))}
    </div>
  );
}

const STATUS_TONE = { 'max-tokens': 'warn', aborted: 'warn', error: 'err' };
function Recent({ data, openSession }) {
  const { t } = useI18n();
  const [more, setMore] = React.useState(false);
  const rows = more ? data.recent : data.recent.slice(0, 15);
  return (
    <>
      <div className="us-list">
        {rows.map((c, i) => (
          <Row key={`${c.t}-${i}`} tone={STATUS_TONE[c.f]} onClick={c.s ? () => openSession(c.s) : undefined}
            lead={<span className="us-time">{stamp(c.t, t)}</span>}
            title={<><span className="us-strong">{splitModel(c.m).name}</span><span className="us-route us-ellipsis">{c.title ?? ''}</span></>}
            badge={c.pu && c.pu !== 'chat' ? t('purpose_' + c.pu) : null}
            meta={joinMeta([
              t('ioShort', { in: tokens(c.in + c.cw), cr: tokens(c.cr), out: tokens(c.out) }),
              duration(c.d, t),
              STATUS_TONE[c.f] ? <span className={'us-' + STATUS_TONE[c.f]}>{t('status_' + c.f)}{c.e ? ` · ${c.e}` : ''}</span> : null,
            ])}
            value={tokens(c.tot)} />
        ))}
      </div>
      {data.recent.length > 15 ? <button type="button" className="us-textbtn" onClick={() => setMore(!more)}>{more ? t('showLess') : t('showMore')}</button> : null}
    </>
  );
}

function Footnote({ data, onReimport }) {
  const { t } = useI18n();
  const h = data.history;
  if (h.importing) return <div className="us-foot">{t('importing', { done: h.progress?.done ?? 0, total: h.progress?.total || '…' })}</div>;
  if (h.error) return <div className="us-foot us-err">{t('importFailed', { error: h.error })} <button type="button" className="us-textbtn" onClick={onReimport}>{t('reimport')}</button></div>;
  if (!h.importedAt || !h.calls) return <div className="us-foot">{t('local')}</div>;
  const d = new Date(data.cutoff);
  return (
    <div className="us-foot">
      {t('imported', { calls: count(h.calls), files: h.files, date: `${d.getMonth() + 1}/${d.getDate()}` })}
      <button type="button" className="us-textbtn" onClick={onReimport}>{t('reimport')}</button>
    </div>
  );
}

function Dashboard({ openSession }) {
  const { t } = useI18n();
  const [range, setRange] = React.useState(() => { try { return localStorage.getItem('dsh-usage:range') || '7d'; } catch { return '7d'; } });
  const [filter, setFilter] = React.useState('');
  const [tab, setTab] = React.useState('sessions');
  const [board, setBoard] = React.useState('daily');
  const [{ loading, error, data }, reload] = useSummary(range, filter);
  const chooseRange = (next) => { setRange(next); try { localStorage.setItem('dsh-usage:range', next); } catch { /* private mode */ } };
  const reimport = async () => { await api.reimport().catch(() => {}); reload(); };
  const filterName = filter ? splitModel(data?.models.find((m) => m.key === filter)?.model ?? filter.split('|')[1]).name : '';
  const empty = data && data.totals.calls === 0;

  return (
    <div className="us-page">
      <div className="us-inner">
        <header className="us-top">
          <h1>{t('title')}</h1>
          <nav className="us-ranges" role="tablist">
            {RANGES.map((r) => <button key={r} type="button" role="tab" aria-selected={range === r} className={range === r ? 'on' : ''} onClick={() => chooseRange(r)}>{t('range_' + r)}</button>)}
          </nav>
        </header>

        {filter ? (
          <button type="button" className="us-chip" onClick={() => setFilter('')} title={t('clearFilter')}>{filterName}<Icon.x size={12} /></button>
        ) : null}
        {error && !data ? <div className="us-quiet us-err">{t('loadFailed', { error })}</div> : null}
        {loading && !data ? <div className="us-quiet">{t('loading')}</div> : null}

        {data ? (
          <div className={'us-body' + (loading ? ' us-stale' : '')}>
            <Hero data={data} range={range} />
            {!empty ? <Notes notes={data.notes} openSession={openSession} /> : null}
            {empty ? (
              <div className="us-empty"><b>{t('empty')}</b><span>{t('emptyHint')}</span></div>
            ) : (
              <>
                <TrendChart series={data.series} bucket={data.range.bucket} />

                <section className="us-section">
                  <div className="us-section-head">
                    <h2>{t('activity')}</h2>
                    <nav className="us-switch" role="tablist">
                      {['daily', 'weekly', 'cumulative'].map((m) => <button key={m} type="button" role="tab" aria-selected={board === m} className={board === m ? 'on' : ''} onClick={() => setBoard(m)}>{t('board_' + m)}</button>)}
                    </nav>
                  </div>
                  <ActivityBoard activity={data.activity} mode={board} />
                </section>

                <section className="us-section">
                  <h2>{t('models')}</h2>
                  <Models data={data} filter={filter} onFilter={setFilter} />
                </section>

                <section className="us-section">
                  <nav className="us-tabs" role="tablist">
                    {[['sessions', t('sessions'), data.totals.sessions], ['tools', t('tools'), data.totals.toolCalls], ['recent', t('recent')]].map(([key, label, n]) => (
                      <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
                        {label}{n !== undefined ? <span>{count(n)}</span> : null}
                      </button>
                    ))}
                  </nav>
                  {tab === 'sessions' ? <Sessions data={data} openSession={openSession} /> : tab === 'tools' ? <Tools data={data} /> : <Recent data={data} openSession={openSession} />}
                </section>
              </>
            )}
            <Footnote data={data} onReimport={reimport} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function makeUsagePage({ openSession, locale }) {
  const Localized = withI18n(locale, Dashboard);
  return function UsagePage() { return <Localized openSession={openSession} />; };
}
