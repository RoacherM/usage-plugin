/** Number and time formatting shared by the page, chart and tests. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

export function tokens(n) {
  if (!n) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 1 : 2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 1 : 2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

export const count = (n) => (n ?? 0).toLocaleString('en-US');
export const percent = (x, digits = 1) => (x === undefined || x === null || Number.isNaN(x) ? '—' : (x * 100).toFixed(digits) + '%');

export function duration(ms, t) {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return t('ms', { n: Math.round(ms) });
  if (ms < 60_000) return t('s', { n: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) });
  if (ms < 3_600_000) return t('min', { n: Math.round(ms / 60_000) });
  return t('h', { n: (ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0) });
}

/** A bucket start in "local epoch" (wall clock encoded as UTC) → a short label. */
export function bucketLabel(at, bucket, t) {
  const d = new Date(at);
  if (bucket === 'hour') return `${pad(d.getUTCHours())}:00`;
  const values = { m: d.getUTCMonth() + 1, mon: MONTHS[d.getUTCMonth()], d: d.getUTCDate() };
  return bucket === 'week' ? t('weekOf', values) : t('monthDay', values);
}
export const bucketAxisLabel = (at, bucket) => {
  const d = new Date(at);
  return bucket === 'hour' ? pad(d.getUTCHours()) : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/** A real epoch time → "14:05" today, "昨天 14:05", or "9月26日 14:05" (browser zone). */
export function stamp(t, tr, now = new Date()) {
  const d = new Date(t);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayDiff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `${tr('yesterday')} ${time}`;
  return `${tr('monthDay', { m: d.getMonth() + 1, mon: MONTHS[d.getMonth()], d: d.getDate() })} ${time}`;
}

/** "claude/claude-opus-5-5" → "claude-opus-5-5"; the route prefix is shown separately. */
export function splitModel(model) {
  const i = model.lastIndexOf('/');
  return i > 0 ? { name: model.slice(i + 1), route: model.slice(0, i) } : { name: model, route: '' };
}

/**
 * One hue, several strengths: the leading model is the solid brand color, the next ones lighter,
 * "other" a neutral gray. Reads calmer than a rainbow and follows the theme in dark mode.
 */
const BRAND = 'var(--dsw-alias-brand-primary, #4d6bfe)';
const RAMP = [100, 68, 46, 32, 22, 15];
export const seriesColor = (key, i) => (key === 'other'
  ? 'color-mix(in srgb, var(--dsw-alias-label-secondary) 22%, transparent)'
  : `color-mix(in srgb, ${BRAND} ${RAMP[i % RAMP.length]}%, transparent)`);
