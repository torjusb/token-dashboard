import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { constants as zlibConstants, createGzip, gzipSync } from 'node:zlib';
import type { ServerMessage, Snapshot, UsageEvent } from '../shared/types.ts';
import type { Store } from './store.ts';

const HEARTBEAT_MS = 15_000;
const DAY_MS = 86_400_000;

const DEV_ORIGINS = new Set(['http://localhost:5273', 'http://127.0.0.1:5273']);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export type ServerOptions = {
  store: Store;
  /** Read per message, so a client that connects mid-backfill is told the truth. */
  backfilling: () => boolean;
  staticDir: string;
  windowDays: number;
};

export type Api = {
  server: Server;
  broadcast(msg: ServerMessage): void;
};

type Sink = { write(chunk: string): unknown; end(): unknown };

type Client = {
  write(frame: string): void;
  end(): void;
  timer: NodeJS.Timeout;
};

export function createServer(opts: ServerOptions): Api {
  const { store, backfilling, windowDays } = opts;
  const staticRoot = resolve(opts.staticDir);
  const clients = new Set<Client>();
  let newestTs: number | null = null;

  const cutoff = () => Date.now() - windowDays * DAY_MS;

  function noteNewest(events: readonly UsageEvent[]): void {
    for (const e of events) if (newestTs === null || e.ts > newestTs) newestTs = e.ts;
  }

  function newestEventTs(): number | null {
    if (newestTs === null) noteNewest(store.eventsSince(cutoff()));
    return newestTs;
  }

  function snapshot(): Snapshot {
    const events = store.eventsSince(cutoff());
    noteNewest(events);
    return {
      type: 'snapshot',
      serverNow: Date.now(),
      windowDays,
      events,
      sessionCosts: store.allSessionCosts(),
      toolCalls: store.toolCallsSince(cutoff()),
      backfilling: backfilling(),
    };
  }

  function drop(client: Client): void {
    if (!clients.delete(client)) return;
    clearInterval(client.timer);
    client.end();
  }

  function broadcast(msg: ServerMessage): void {
    if (msg.type === 'delta') noteNewest(msg.events);
    if (clients.size === 0) return;
    const frame = sseFrame(msg);
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        drop(client);
      }
    }
  }

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };
    const gzip = acceptsGzip(req) ? createGzip() : null;
    if (gzip !== null) headers['Content-Encoding'] = 'gzip';

    res.writeHead(200, headers);
    res.flushHeaders();
    req.socket.setNoDelay(true);

    const sink: Sink = gzip ?? res;
    const client: Client = {
      write: (frame) => {
        sink.write(frame);
        gzip?.flush(zlibConstants.Z_SYNC_FLUSH);
      },
      end: () => void sink.end(),
      timer: setInterval(() => beat(), HEARTBEAT_MS),
    };

    function beat(): void {
      try {
        client.write(sseFrame({ type: 'heartbeat', serverNow: Date.now() }));
      } catch {
        drop(client);
      }
    }

    if (gzip !== null) {
      gzip.pipe(res);
      gzip.on('error', () => drop(client));
    }
    res.on('close', () => drop(client));
    res.on('error', () => drop(client));
    req.on('error', () => drop(client));

    clients.add(client);
    client.write(sseFrame(snapshot()));
  }

  function health(req: IncomingMessage, res: ServerResponse): void {
    sendJson(req, res, {
      events: store.countEvents(),
      newestEventTs: newestEventTs(),
      backfilling: backfilling(),
      clients: clients.size,
      uptimeSec: Math.round(process.uptime()),
      serverNow: Date.now(),
    });
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('bad path\n');
      return;
    }

    const target = resolve(staticRoot, `.${normalize(decoded)}`);
    if (target !== staticRoot && !target.startsWith(staticRoot + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden\n');
      return;
    }

    const index = join(staticRoot, 'index.html');
    const file = isFile(target) ? target : index;
    if (!isFile(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(`no build at ${staticRoot}\nrun: npm run build (or npm run web for the dev server)\n`);
      return;
    }

    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  const server = createHttpServer((req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined && DEV_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin, Accept-Encoding');

    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end();
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://dashboard.local').pathname;
    if (pathname === '/api/snapshot') sendJson(req, res, snapshot());
    else if (pathname === '/api/events') openStream(req, res);
    else if (pathname === '/api/health') health(req, res);
    else serveStatic(pathname, res);
  });

  return { server, broadcast };
}

function sseFrame(msg: ServerMessage): string {
  return `data: ${JSON.stringify(msg)}\n\n`;
}

function acceptsGzip(req: IncomingMessage): boolean {
  return /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
}

function sendJson(req: IncomingMessage, res: ServerResponse, body: unknown): void {
  const json = JSON.stringify(body);
  if (acceptsGzip(req)) {
    const buf = gzipSync(json);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': buf.byteLength,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
