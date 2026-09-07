import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageEvent, SessionCost, ToolCall, Effort } from '../shared/types.ts';

export type Store = {
  upsertEvents(events: UsageEvent[]): UsageEvent[];
  upsertSessionCosts(costs: SessionCost[]): SessionCost[];
  upsertToolCalls(calls: ToolCall[]): ToolCall[];
  eventsSince(tsMs: number): UsageEvent[];
  allSessionCosts(): SessionCost[];
  toolCallsSince(tsMs: number): ToolCall[];
  getOffset(filePath: string): { offset: number; size: number; mtimeMs: number } | null;
  setOffset(filePath: string, offset: number, size: number, mtimeMs: number): void;
  countEvents(): number;
  countToolCalls(): number;
  pruneBefore(tsMs: number): number;
  close(): void;
};

const EVENT_COLUMNS = [
  'requestId', 'ts', 'sessionId', 'project', 'cwd', 'gitBranch', 'slug', 'model',
  'effort', 'serviceTier', 'isSidechain', 'attributionAgent', 'attributionSkill',
  'attributionPlugin', 'input', 'output', 'thinking', 'cacheRead', 'cacheWrite5m',
  'cacheWrite1h', 'webSearch', 'webFetch', 'cost', 'version',
] as const;

type EventRow = {
  requestId: string;
  ts: number;
  sessionId: string;
  project: string;
  cwd: string;
  gitBranch: string | null;
  slug: string | null;
  model: string;
  effort: string | null;
  serviceTier: string | null;
  isSidechain: number;
  attributionAgent: string | null;
  attributionSkill: string | null;
  attributionPlugin: string | null;
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  webFetch: number;
  cost: number;
  version: string | null;
};

type SessionCostRow = {
  sessionId: string;
  totalCostUSD: number;
  totalDurationMs: number;
  totalApiDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  startTime: number;
  byModel: string;
};

type ToolCallRow = {
  id: string;
  requestId: string;
  ts: number;
  name: string;
};

function rowToEvent(row: EventRow): UsageEvent {
  return {
    requestId: row.requestId,
    ts: row.ts,
    sessionId: row.sessionId,
    project: row.project,
    cwd: row.cwd,
    gitBranch: row.gitBranch,
    slug: row.slug,
    model: row.model,
    effort: row.effort as Effort | null,
    serviceTier: row.serviceTier,
    isSidechain: row.isSidechain !== 0,
    attributionAgent: row.attributionAgent,
    attributionSkill: row.attributionSkill,
    attributionPlugin: row.attributionPlugin,
    input: row.input,
    output: row.output,
    thinking: row.thinking,
    cacheRead: row.cacheRead,
    cacheWrite5m: row.cacheWrite5m,
    cacheWrite1h: row.cacheWrite1h,
    webSearch: row.webSearch,
    webFetch: row.webFetch,
    cost: row.cost,
    version: row.version,
  };
}

function rowToSessionCost(row: SessionCostRow): SessionCost {
  return {
    sessionId: row.sessionId,
    totalCostUSD: row.totalCostUSD,
    totalDurationMs: row.totalDurationMs,
    totalApiDurationMs: row.totalApiDurationMs,
    linesAdded: row.linesAdded,
    linesRemoved: row.linesRemoved,
    startTime: row.startTime,
    byModel: JSON.parse(row.byModel) as Record<string, number>,
  };
}

function stableStringify(obj: Record<string, number>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(obj, keys);
}

export function openStore(dbPath: string): Store {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      requestId TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      sessionId TEXT NOT NULL,
      project TEXT NOT NULL,
      cwd TEXT NOT NULL,
      gitBranch TEXT,
      slug TEXT,
      model TEXT NOT NULL,
      effort TEXT,
      serviceTier TEXT,
      isSidechain INTEGER NOT NULL,
      attributionAgent TEXT,
      attributionSkill TEXT,
      attributionPlugin TEXT,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      thinking INTEGER NOT NULL,
      cacheRead INTEGER NOT NULL,
      cacheWrite5m INTEGER NOT NULL,
      cacheWrite1h INTEGER NOT NULL,
      webSearch INTEGER NOT NULL,
      webFetch INTEGER NOT NULL,
      cost REAL NOT NULL,
      version TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_sessionId ON events(sessionId)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_costs (
      sessionId TEXT PRIMARY KEY,
      totalCostUSD REAL NOT NULL,
      totalDurationMs INTEGER NOT NULL,
      totalApiDurationMs INTEGER NOT NULL,
      linesAdded INTEGER NOT NULL,
      linesRemoved INTEGER NOT NULL,
      startTime INTEGER NOT NULL,
      byModel TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      requestId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      name TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(ts)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS offsets (
      filePath TEXT PRIMARY KEY,
      offset INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mtimeMs REAL NOT NULL
    )
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (${EVENT_COLUMNS.join(', ')})
    VALUES (${EVENT_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT(requestId) DO NOTHING
  `);

  const selectSessionCost = db.prepare('SELECT * FROM session_costs WHERE sessionId = ?');
  const upsertSessionCost = db.prepare(`
    INSERT INTO session_costs
      (sessionId, totalCostUSD, totalDurationMs, totalApiDurationMs, linesAdded, linesRemoved, startTime, byModel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      totalCostUSD = excluded.totalCostUSD,
      totalDurationMs = excluded.totalDurationMs,
      totalApiDurationMs = excluded.totalApiDurationMs,
      linesAdded = excluded.linesAdded,
      linesRemoved = excluded.linesRemoved,
      startTime = excluded.startTime,
      byModel = excluded.byModel
  `);

  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls (id, requestId, ts, name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  const selectEventsSince = db.prepare('SELECT * FROM events WHERE ts >= ? ORDER BY ts ASC');
  const selectToolCallsSince = db.prepare('SELECT * FROM tool_calls WHERE ts >= ? ORDER BY ts ASC');
  const selectAllSessionCosts = db.prepare('SELECT * FROM session_costs');
  const selectOffset = db.prepare('SELECT offset, size, mtimeMs FROM offsets WHERE filePath = ?');
  const upsertOffset = db.prepare(`
    INSERT INTO offsets (filePath, offset, size, mtimeMs) VALUES (?, ?, ?, ?)
    ON CONFLICT(filePath) DO UPDATE SET offset = excluded.offset, size = excluded.size, mtimeMs = excluded.mtimeMs
  `);
  const selectCount = db.prepare('SELECT COUNT(*) AS c FROM events');
  const selectToolCallCount = db.prepare('SELECT COUNT(*) AS c FROM tool_calls');
  const deleteBefore = db.prepare('DELETE FROM events WHERE ts < ?');
  const deleteToolCallsBefore = db.prepare('DELETE FROM tool_calls WHERE ts < ?');

  function upsertEvents(events: UsageEvent[]): UsageEvent[] {
    const inserted: UsageEvent[] = [];
    if (events.length === 0) return inserted;
    db.exec('BEGIN');
    try {
      for (const e of events) {
        const result = insertEvent.run(
          e.requestId, e.ts, e.sessionId, e.project, e.cwd, e.gitBranch, e.slug,
          e.model, e.effort, e.serviceTier, e.isSidechain ? 1 : 0, e.attributionAgent,
          e.attributionSkill, e.attributionPlugin, e.input, e.output, e.thinking,
          e.cacheRead, e.cacheWrite5m, e.cacheWrite1h, e.webSearch, e.webFetch,
          e.cost, e.version,
        );
        if (Number(result.changes) > 0) inserted.push(e);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return inserted;
  }

  function upsertToolCalls(calls: ToolCall[]): ToolCall[] {
    const inserted: ToolCall[] = [];
    if (calls.length === 0) return inserted;
    db.exec('BEGIN');
    try {
      for (const c of calls) {
        const result = insertToolCall.run(c.id, c.requestId, c.ts, c.name);
        if (Number(result.changes) > 0) inserted.push(c);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return inserted;
  }

  function upsertSessionCosts(costs: SessionCost[]): SessionCost[] {
    const changed: SessionCost[] = [];
    if (costs.length === 0) return changed;
    db.exec('BEGIN');
    try {
      for (const c of costs) {
        const existing = selectSessionCost.get(c.sessionId) as SessionCostRow | undefined;
        const byModelJson = stableStringify(c.byModel);
        const isSame = existing !== undefined
          && existing.totalCostUSD === c.totalCostUSD
          && existing.totalDurationMs === c.totalDurationMs
          && existing.totalApiDurationMs === c.totalApiDurationMs
          && existing.linesAdded === c.linesAdded
          && existing.linesRemoved === c.linesRemoved
          && existing.startTime === c.startTime
          && existing.byModel === byModelJson;
        if (isSame) continue;
        upsertSessionCost.run(
          c.sessionId, c.totalCostUSD, c.totalDurationMs, c.totalApiDurationMs,
          c.linesAdded, c.linesRemoved, c.startTime, byModelJson,
        );
        changed.push(c);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return changed;
  }

  return {
    upsertEvents,
    upsertSessionCosts,
    upsertToolCalls,
    eventsSince(tsMs: number): UsageEvent[] {
      return (selectEventsSince.all(tsMs) as EventRow[]).map(rowToEvent);
    },
    allSessionCosts(): SessionCost[] {
      return (selectAllSessionCosts.all() as SessionCostRow[]).map(rowToSessionCost);
    },
    toolCallsSince(tsMs: number): ToolCall[] {
      return selectToolCallsSince.all(tsMs) as ToolCallRow[];
    },
    getOffset(filePath: string) {
      const row = selectOffset.get(filePath) as { offset: number; size: number; mtimeMs: number } | undefined;
      return row ?? null;
    },
    setOffset(filePath: string, offset: number, size: number, mtimeMs: number): void {
      upsertOffset.run(filePath, offset, size, mtimeMs);
    },
    countEvents(): number {
      const row = selectCount.get() as { c: number };
      return row.c;
    },
    countToolCalls(): number {
      const row = selectToolCallCount.get() as { c: number };
      return row.c;
    },
    pruneBefore(tsMs: number): number {
      const result = deleteBefore.run(tsMs);
      deleteToolCallsBefore.run(tsMs);
      // Callers report this as an event count, so the tool-call rows are not added in.
      return Number(result.changes);
    },
    close(): void {
      db.close();
    },
  };
}
