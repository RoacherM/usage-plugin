/**
 * Import usage that happened before the plugin was installed, from DSH's own session logs
 * (~/.dsh/sessions/<workspace>/<session>/session.v<N>.jsonl[.zstd]).
 *
 * The logs are appended as a sequence of independent zstd frames; Node's zstd decoder stops after
 * the first frame, so each frame is decoded on its own. Only events older than the ledger cutoff
 * are imported — newer ones were recorded live. Seeded (forked) sessions repeat their parent's
 * events, so model calls are deduplicated by message id and tool calls by call id.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { createSessionFold } from './records.js';

export const defaultSessionsDir = () => join(homedir(), '.dsh', 'sessions');

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** Decode a buffer made of concatenated zstd frames (a false magic inside a frame is merged away). */
export function decodeFrames(raw) {
  const starts = [];
  for (let i = 0; i <= raw.length - 4; i++) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i);
  }
  if (!starts.length) return '';
  const parts = [];
  let from = 0;
  for (let k = 1; k <= starts.length; k++) {
    const end = k < starts.length ? starts[k] : raw.length;
    try {
      parts.push(zstdDecompressSync(raw.subarray(starts[from], end)));
      from = k;
    } catch (error) {
      if (k === starts.length) {
        // A torn final frame (the app was writing): keep what decoded.
        if (parts.length) break;
        throw error;
      }
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

async function readLog(file) {
  const raw = await readFile(file);
  const text = file.endsWith('.zstd') ? decodeFrames(raw) : raw.toString('utf8');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return events;
}

/** Newest log format per session directory. */
async function findLogs(root) {
  const logs = [];
  let workspaces;
  try { workspaces = await readdir(root, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return logs;
    throw error;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const sessions = await readdir(join(root, workspace.name), { withFileTypes: true }).catch(() => []);
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const dir = join(root, workspace.name, session.name);
      const files = (await readdir(dir).catch(() => []))
        .map((name) => ({ name, version: Number(/^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name)?.[1]) }))
        .filter((f) => Number.isFinite(f.version))
        .sort((a, b) => b.version - a.version || (a.name.endsWith('.zstd') ? -1 : 1));
      if (files[0]) logs.push(join(dir, files[0].name));
    }
  }
  return logs;
}

/**
 * Scan every session log. Returns calls/tools before `before`, and what the logs say about each
 * session (title, cwd, parent, origin) regardless of time.
 */
export async function scanSessionLogs({ root = defaultSessionsDir(), before = Infinity, onProgress } = {}) {
  const logs = await findLogs(root);
  const calls = [];
  const tools = [];
  const sessions = {};
  const seenCalls = new Set();
  const seenTools = new Set();
  const failed = [];
  let done = 0;

  for (const file of logs) {
    let events;
    try { events = await readLog(file); } catch (error) {
      failed.push({ file, error: error.message });
      continue;
    }
    const header = events[0]?.type === 'session' ? events[0] : undefined;
    const id = header?.id;
    if (!id) continue;
    const info = { cwd: header.cwd, parent: header.parentSession, origin: header.origin, createdAt: header.createdAt };
    const fold = createSessionFold(id, {
      calls: true, before,
      emitCall: (record, key) => { if (key && seenCalls.has(key)) return; if (key) seenCalls.add(key); calls.push(record); },
      emitTool: (record, key) => { if (key && seenTools.has(key)) return; if (key) seenTools.add(key); tools.push(record); },
    });
    for (let i = 1; i < events.length; i++) {
      const event = events[i];
      if (event.type === 'session/title' && event.data?.title) info.title = event.data.title;
      if (event.time !== undefined) info.lastAt = event.time;
      fold(event);
    }
    sessions[id] = info;
    done++;
    onProgress?.(done, logs.length);
    // Let the Host breathe between files.
    await new Promise((resolve) => setImmediate(resolve));
  }
  calls.sort((a, b) => a.t - b.t);
  tools.sort((a, b) => a.t - b.t);
  return { calls, tools, sessions, files: logs.length, failed };
}

export async function sessionsRootExists(root = defaultSessionsDir()) {
  try { return (await stat(root)).isDirectory(); } catch { return false; }
}
