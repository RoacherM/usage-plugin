/**
 * The usage ledger: every model call and tool call as one compact JSON line.
 *
 *   calls-YYYY-MM.jsonl / tools-YYYY-MM.jsonl — recorded live, append-only, one file per month
 *   history.json                              — calls and tools imported from session logs that
 *                                               predate the plugin; replaced atomically on re-import
 *   meta.json                                 — install cutoff, session titles
 *
 * Everything is kept in memory too (a year of heavy use is tens of MB at most), so the dashboard
 * aggregates without touching the disk.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultDataDir = () => process.env.DSH_USAGE_DIR ?? join(homedir(), '.dsh', 'plugin-data', 'usage');

const month = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}

function parseLines(text, into) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { into.push(JSON.parse(line)); } catch { /* a torn last line after a crash */ }
  }
}

export function createLedger({ dir = defaultDataDir(), onChange = () => {} } = {}) {
  const state = {
    live: { calls: [], tools: [] },
    history: { calls: [], tools: [], importedAt: undefined, files: 0, error: undefined },
    meta: { version: 1, cutoff: undefined, sessions: {} },
  };
  let queue = Promise.resolve();
  const exclusive = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  let metaTimer;

  async function load() {
    try {
      await mkdir(dir, { recursive: true });
      const stored = await readJson(join(dir, 'meta.json'), {});
      // Titles noted while loading are newer than the stored ones.
      state.meta = { ...state.meta, ...stored, sessions: { ...stored.sessions, ...state.meta.sessions } };
      const history = await readJson(join(dir, 'history.json'), undefined);
      if (history) Object.assign(state.history, { calls: history.calls ?? [], tools: history.tools ?? [], importedAt: history.importedAt, files: history.files ?? 0 });
      for (const name of (await readdir(dir)).sort()) {
        const kind = /^(calls|tools)-\d{4}-\d{2}\.jsonl$/.exec(name)?.[1];
        if (kind) parseLines(await readFile(join(dir, name), 'utf8'), state.live[kind]);
      }
      if (state.meta.cutoff === undefined) {
        // Everything before this moment comes from session logs; everything after is recorded live.
        state.meta.cutoff = Math.min(state.live.calls[0]?.t ?? Infinity, ...early.map(([, r]) => r.t), Date.now());
        await saveMeta();
      }
    } finally {
      const held = early;
      early = undefined;
      for (const [kind, record] of held) append(kind, record);
    }
    return ledger;
  }

  const saveMeta = () => exclusive(() => writeAtomic(join(dir, 'meta.json'), JSON.stringify(state.meta)));
  /** Titles arrive in bursts while a session starts; write the meta file at most once a second. */
  const saveMetaSoon = () => { clearTimeout(metaTimer); metaTimer = setTimeout(() => { saveMeta().catch(() => {}); }, 1000); };

  // Records that arrive while the files are still loading are held back, then written after them.
  let early = [];
  function append(kind, record) {
    if (early) { early.push([kind, record]); return; }
    state.live[kind].push(record);
    const line = JSON.stringify(record) + '\n';
    exclusive(() => appendFile(join(dir, `${kind}-${month(record.t)}.jsonl`), line)).catch(() => {});
    onChange();
  }

  const ledger = {
    dir,
    load,
    get cutoff() { return state.meta.cutoff; },
    addCall: (record) => append('calls', record),
    addTool: (record) => append('tools', record),
    calls: () => state.history.calls.length ? state.history.calls.concat(state.live.calls) : state.live.calls,
    tools: () => state.history.tools.length ? state.history.tools.concat(state.live.tools) : state.live.tools,
    history: () => ({ importedAt: state.history.importedAt, files: state.history.files, calls: state.history.calls.length, tools: state.history.tools.length, error: state.history.error }),
    sessions: () => state.meta.sessions,
    /** Merge what is known about a session (title, cwd, parent, origin); unknown fields are kept. */
    noteSession(id, info) {
      if (!id) return;
      const current = state.meta.sessions[id] ?? {};
      const next = { ...current };
      for (const [key, value] of Object.entries(info)) if (value !== undefined && value !== null && value !== '') next[key] = value;
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      state.meta.sessions[id] = next;
      saveMetaSoon();
      onChange();
    },
    async replaceHistory({ calls, tools, files, sessions }) {
      const importedAt = Date.now();
      await exclusive(() => writeAtomic(join(dir, 'history.json'), JSON.stringify({ version: 1, importedAt, files, calls, tools })));
      Object.assign(state.history, { calls, tools, files, importedAt, error: undefined });
      for (const [id, info] of Object.entries(sessions ?? {})) {
        // Live titles are newer than anything in an old log.
        state.meta.sessions[id] = { ...info, ...state.meta.sessions[id] };
      }
      await saveMeta();
      onChange();
    },
    failHistory(error) { state.history.error = error; onChange(); },
    async flush() { clearTimeout(metaTimer); await saveMeta(); await queue; },
  };
  return ledger;
}
