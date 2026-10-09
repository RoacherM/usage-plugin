// Snapshot the local ledger into data.json so the preview renders real numbers.
import { writeFileSync } from 'node:fs';
import { createLedger } from '../src/host/ledger.js';
const ledger = await createLedger({}).load();
writeFileSync(new URL('./data.json', import.meta.url), JSON.stringify({
  calls: ledger.calls(), tools: ledger.tools(), sessions: ledger.sessions(), history: ledger.history(), cutoff: ledger.cutoff, at: Date.now(),
}));
console.log('calls', ledger.calls().length);
