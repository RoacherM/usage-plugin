/**
 * Tokens over time: frameless stacked bars (one hue, a strength per model), the peak as the only
 * scale line, and a hover card with the bucket's breakdown. Plain SVG, no chart library.
 */
import React from 'react';
import { bucketAxisLabel, bucketLabel, count, seriesColor, splitModel, tokens } from './format.js';
import { useI18n } from './i18n.jsx';

const H = 168;
const TOP = 20;
const BOTTOM = 24;

function useWidth() {
  const ref = React.useRef(null);
  const [width, setWidth] = React.useState(760);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    setWidth(node.clientWidth || 760);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const sum = (list) => list.reduce((a, b) => a + b, 0);

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LEVELS = [18, 36, 58, 80, 100];

/** Level 0 (empty) to 5, by where a value sits among the non-zero values: a few huge days never wash out the rest. */
function leveler(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return () => 0;
  const cuts = [0.2, 0.4, 0.6, 0.8].map((q) => sorted[Math.floor(q * (sorted.length - 1))]);
  return (v) => (v <= 0 ? 0 : 1 + cuts.filter((c) => v > c).length);
}

/**
 * A year of days as a GitHub-style board (Monday-first columns). `mode`: daily (each day on its
 * own), weekly (the whole week shares its total), cumulative (running total, so it only deepens).
 */
export function ActivityBoard({ activity, mode }) {
  const { t, lang } = useI18n();
  const [ref, width] = useWidth();
  const [hover, setHover] = React.useState(null);
  const n = activity.tot.length;
  const weeks = Math.ceil(n / 7);
  const values = React.useMemo(() => {
    if (mode === 'weekly') {
      const out = new Array(n).fill(0);
      for (let w = 0; w < weeks; w++) {
        const total = sum(activity.tot.slice(w * 7, w * 7 + 7));
        for (let d = w * 7; d < Math.min(n, w * 7 + 7); d++) out[d] = total;
      }
      return out;
    }
    if (mode === 'cumulative') { let run = 0; return activity.tot.map((v) => (run += v)); }
    return activity.tot;
  }, [activity, mode, n, weeks]);
  // A running total only grows, so it is shaded linearly against the final total.
  const level = React.useMemo(() => {
    if (mode !== 'cumulative') return leveler(values);
    const top = values[values.length - 1] || 1;
    return (v) => (v <= 0 ? 0 : Math.max(1, Math.ceil((v / top) * 5)));
  }, [values, mode]);

  const gap = 3;
  const cell = Math.max(6, Math.min(15, Math.floor((width - (weeks - 1) * gap) / weeks)));
  const pitch = cell + gap;
  const gridW = weeks * pitch - gap;
  const labelY = 7 * pitch + 14;
  const months = [];
  for (let w = 0; w < weeks; w++) {
    const date = new Date(activity.start + w * 7 * DAY);
    const prev = w ? new Date(activity.start + (w - 1) * 7 * DAY) : null;
    if (!prev || prev.getUTCMonth() !== date.getUTCMonth()) months.push({ w, m: date.getUTCMonth() });
  }
  // Skip a month label that would collide with the previous one (the first partial month).
  const shown = months.filter((m, i) => i === months.length - 1 || months[i + 1].w - m.w >= 3);
  const hovered = hover;
  const tip = hovered !== null ? (() => {
    const date = new Date(activity.start + hovered * DAY);
    const md = lang === 'zh' ? `${date.getUTCMonth() + 1}月${date.getUTCDate()}日` : `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
    if (mode === 'weekly') {
      const w = Math.floor(hovered / 7);
      const monday = new Date(activity.start + w * 7 * DAY);
      return { head: t('weekOf', { m: monday.getUTCMonth() + 1, mon: MONTHS[monday.getUTCMonth()], d: monday.getUTCDate() }), value: values[hovered], calls: sum(activity.calls.slice(w * 7, w * 7 + 7)) };
    }
    if (mode === 'cumulative') return { head: t('untilDay', { day: md }), value: values[hovered] };
    return { head: md, value: values[hovered], calls: activity.calls[hovered] };
  })() : null;

  return (
    <div className="us-board" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={gridW} height={labelY + 2} role="img" aria-label={t('activity')}>
        {values.map((v, i) => {
          const w = Math.floor(i / 7);
          const lv = level(v);
          return (
            <rect key={i} x={w * pitch} y={(i % 7) * pitch} width={cell} height={cell} rx={Math.min(3, cell / 4)}
              className={'us-cell' + (lv ? '' : ' empty') + (hover === i ? ' on' : '')}
              style={lv ? { fill: `color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) ${LEVELS[lv - 1]}%, transparent)` } : undefined}
              onMouseEnter={() => setHover(i)} />
          );
        })}
        {shown.map(({ w, m }) => (
          <text key={w} x={w * pitch} y={labelY} className="us-tick">{lang === 'zh' ? `${m + 1}月` : MONTHS[m]}</text>
        ))}
      </svg>
      {tip ? (
        <div className="us-tip us-board-tip" style={{ left: Math.min(Math.max(Math.floor(hovered / 7) * pitch + cell / 2, 90), gridW - 90), top: (hovered % 7) * pitch - 4 }}>
          <div className="us-tip-head"><span>{tip.head}</span><b>{tokens(tip.value)}</b></div>
          {tip.calls !== undefined ? <div className="us-tip-row"><span className="us-quiet">{t('nCalls', { n: count(tip.calls) })}</span></div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function TrendChart({ series, bucket }) {
  const { t } = useI18n();
  const [ref, width] = useWidth();
  const [active, setActive] = React.useState(null);
  const { rows, keys, labels } = series;
  const totals = rows.map((row) => sum(row.tok));
  const peak = Math.max(0, ...totals);
  const plotH = H - TOP - BOTTOM;
  const slot = width / Math.max(1, rows.length);
  const barW = Math.max(3, Math.min(28, slot * 0.58));
  const y = (v) => TOP + plotH - (v / (peak || 1)) * plotH;
  // The last label always, then evenly spaced ones that do not crowd it.
  const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(width / 64))));
  const showLabel = (i) => i === rows.length - 1 || (i % every === 0 && rows.length - 1 - i >= every / 2);
  const row = active !== null ? rows[active] : null;

  return (
    <div className="us-chart" ref={ref} onMouseLeave={() => setActive(null)}>
      <svg width={width} height={H} role="img" aria-label={t('trend')}>
        {peak ? (
          <g className="us-peak">
            <line x1={0} x2={width} y1={TOP} y2={TOP} />
            <text x={width} y={TOP - 6} textAnchor="end">{tokens(peak)}</text>
          </g>
        ) : null}
        <line className="us-base" x1={0} x2={width} y1={TOP + plotH + 0.5} y2={TOP + plotH + 0.5} />
        {rows.map((r, i) => {
          const x = i * slot + (slot - barW) / 2;
          let acc = 0;
          return (
            <g key={r.at} onMouseEnter={() => setActive(i)} className={active !== null && active !== i ? 'us-dim' : undefined}>
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              {r.tok.map((v, k) => {
                if (!v) return null;
                const top = y(acc + v);
                const h = Math.max(y(acc) - top, 2);
                acc += v;
                return <rect key={k} x={x} y={top} width={barW} height={h} rx={Math.min(2.5, barW / 4)} style={{ fill: seriesColor(keys[k], k) }} pointerEvents="none" />;
              })}
              {showLabel(i) ? <text x={i * slot + slot / 2} y={H - 6} textAnchor="middle" className={'us-tick' + (i === active ? ' on' : '')}>{bucketAxisLabel(r.at, bucket)}</text> : null}
            </g>
          );
        })}
      </svg>
      {row ? (
        <div className="us-tip" style={{ left: Math.min(Math.max(active * slot + slot / 2, 104), width - 104) }}>
          <div className="us-tip-head"><span>{bucketLabel(row.at, bucket, t)}</span><b>{tokens(totals[active])}</b></div>
          {keys.map((key, k) => (row.tok[k] || row.calls[k] ? (
            <div className="us-tip-row" key={key}>
              <i style={{ background: seriesColor(key, k) }} />
              <span>{key === 'other' ? t('other') : splitModel(labels[k] ?? key).name}</span>
              <em>{t('nCalls', { n: count(row.calls[k]) })}</em>
              <b>{tokens(row.tok[k])}</b>
            </div>
          ) : null))}
          {!totals[active] && !sum(row.calls) ? <div className="us-tip-row"><span className="us-quiet">{t('idle')}</span></div> : null}
          {row.errors ? <div className="us-tip-row err"><span>{t('nFailed', { n: row.errors })}</span></div> : null}
        </div>
      ) : null}
    </div>
  );
}
