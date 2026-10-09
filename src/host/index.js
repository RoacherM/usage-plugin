/**
 * Host half of the usage dashboard: records every model call and tool call into a local ledger,
 * imports the history that predates the plugin from session logs, and serves aggregates to the
 * page and to the `usage_report` tool. Only `ctx` services are used — no @deepseek-ai imports.
 */
import { scanSessionLogs } from './backfill.js';
import { createLedger } from './ledger.js';
import { installRecorder } from './recorder.js';
import { registerRoutes } from './routes.js';
import { registerTools } from './tools.js';

export const name = 'dsh-usage';
export const inject = ['connection', 'tools'];

export function apply(ctx, config = {}) {
  const log = (message) => ctx.logger?.warn?.(message);

  // Change feed for the page's long-poll; bursts of records (a streaming turn) wake it once.
  const listeners = new Set();
  let pending;
  const changes = {
    revision: 0,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    bump() {
      if (pending) return;
      pending = setTimeout(() => { pending = undefined; changes.revision++; for (const fn of listeners) fn(); }, 400);
    },
  };

  const ledger = createLedger({ dir: config.dataDir, onChange: () => changes.bump() });
  const ready = ledger.load();

  let importing = { importing: false, progress: undefined };
  const importState = () => importing;
  async function importHistory() {
    if (importing.importing) return;
    await ready;
    importing = { importing: true, progress: { done: 0, total: 0 } };
    changes.bump();
    try {
      const scan = await scanSessionLogs({
        root: config.sessionsDir, before: ledger.cutoff,
        onProgress: (done, total) => { importing.progress = { done, total }; if (done % 10 === 0) changes.bump(); },
      });
      if (scan.failed.length) log(`dsh-usage: ${scan.failed.length} session logs could not be read (${scan.failed[0].file}: ${scan.failed[0].error})`);
      await ledger.replaceHistory(scan);
    } catch (error) {
      log(`dsh-usage: history import failed: ${error.message}`);
      ledger.failHistory(error.message);
    } finally {
      importing = { importing: false, progress: undefined };
      changes.bump();
    }
  }

  installRecorder(ctx, ledger);
  registerRoutes(ctx, { ledger, changes, importHistory, importState });
  registerTools(ctx, { ledger });

  ready.then(() => {
    // First start: import everything the session logs already know about.
    if (!ledger.history().importedAt && config.importHistory !== false) importHistory();
  }).catch((error) => log(`dsh-usage: cannot load ledger: ${error.message}`));

  ctx.effect(() => () => { clearTimeout(pending); ledger.flush().catch(() => {}); }, 'dsh-usage: flush');
}
