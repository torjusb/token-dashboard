import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage } from '../shared/types.ts';
import { createServer } from './http.ts';
import { createScanner } from './scan.ts';
import { openStore } from './store.ts';

const WINDOW_DAYS = 30;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number.parseInt(process.env.PORT ?? '', 10) || 4317;

const store = openStore(join(root, 'data', 'usage.db'));

let broadcast: (msg: ServerMessage) => void = () => {};
let backfilling = true;

const scanner = createScanner({
  root: join(homedir(), '.claude', 'projects'),
  store,
  windowDays: WINDOW_DAYS,
  onEvents: (events, sessionCosts) =>
    broadcast({ type: 'delta', serverNow: Date.now(), events, sessionCosts }),
});

const api = createServer({
  store,
  backfilling: () => backfilling,
  staticDir: join(root, 'web', 'dist'),
  windowDays: WINDOW_DAYS,
});
broadcast = api.broadcast;

api.server.listen(port, '127.0.0.1', () => {
  console.log(`[main] token-dashboard on http://127.0.0.1:${port} (${store.countEvents()} events in store)`);
});

void (async () => {
  try {
    const fresh = await scanner.backfill();
    console.log(`[main] backfill added ${fresh} events`);
  } catch (err) {
    console.error('[main] backfill failed:', err);
  }
  backfilling = false;
  broadcast({ type: 'backfill-done', serverNow: Date.now(), total: store.countEvents() });
  scanner.watch();
  console.log('[main] watching for new requests');
})();

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[main] ${signal}, shutting down`);
  scanner.stop();
  api.server.closeAllConnections();
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
