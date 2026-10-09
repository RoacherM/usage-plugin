/**
 * Authenticated `/api/usage/*` routes for the dashboard (through `ctx.connection.fetch`).
 */
import { aggregate } from './aggregate.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export function registerRoutes(ctx, { ledger, changes, importHistory, importState }) {
  const summary = (url) => {
    const q = url.searchParams;
    return {
      ...aggregate({
        calls: ledger.calls(), tools: ledger.tools(), sessions: ledger.sessions(),
        range: q.get('range') ?? '7d', timeZone: q.get('tz') ?? 'UTC', filter: q.get('model') || undefined,
      }),
      history: { ...ledger.history(), ...importState() },
      cutoff: ledger.cutoff,
      revision: changes.revision,
    };
  };

  const routes = [
    ['GET', '/api/usage/summary', async (request, url) => json(summary(url))],
    ['GET', '/api/usage/wait', async (request, url) => {
      const since = Number(url.searchParams.get('revision') ?? -1);
      if (changes.revision === since) {
        await new Promise((resolve) => {
          const timer = setTimeout(done, 5_000);
          const unsubscribe = changes.subscribe(done);
          request.signal?.addEventListener('abort', done, { once: true });
          function done() { clearTimeout(timer); unsubscribe(); resolve(); }
        });
      }
      return json({ revision: changes.revision });
    }],
    ['POST', '/api/usage/import', async () => {
      importHistory().catch(() => {});
      return json({ started: true });
    }],
  ];

  for (const [method, path, fn] of routes) {
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods: [method], requestBody: 'buffered',
      fetch: async (request) => {
        try { return await fn(request, new URL(request.url)); } catch (error) {
          return json({ error: error?.message ?? String(error) }, 500);
        }
      },
    }), 'dsh-usage: ' + path);
  }
}
