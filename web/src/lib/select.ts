import { mcpTarget } from '../../../shared/types.ts';
import type { HumanTurn, SessionCost, ToolCall, UsageEvent } from '../../../shared/types.ts';
import type { Filters } from './filters.tsx';

export type Totals = {
  requests: number;
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWrite: number;
  webSearch: number;
  webFetch: number;
  cost: number;
  uncachedCost: number;
  totalTokens: number;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MTOK = 1_000_000;

const INPUT_USD_PER_MTOK: Record<string, number> = {
  'claude-fable-5-1': 10,
  'claude-fable-5': 10,
  'claude-mythos-5-1': 10,
  'claude-mythos-5': 10,
  'claude-opus-5': 5,
  'claude-opus-4-8': 5,
  'claude-opus-4-7': 5,
  'claude-opus-4-6': 5,
  'claude-opus-4-5': 5,
  'claude-sonnet-5': 2,
  'claude-sonnet-4-6': 3,
  'claude-sonnet-4-5': 3,
  'claude-haiku-4-5': 1,
};

const FAMILY_USD_PER_MTOK: ReadonlyArray<readonly [string, number]> = [
  ['mythos', 10],
  ['fable', 10],
  ['haiku', 1],
  ['sonnet', 2],
  ['opus', 5],
];

function inputRate(model: string): number {
  const base = model.replace('[1m]', '').replace(/-\d{8}$/, '');
  const exact = INPUT_USD_PER_MTOK[base];
  if (exact !== undefined) return exact / MTOK;
  const lower = base.toLowerCase();
  for (const [needle, usd] of FAMILY_USD_PER_MTOK) {
    if (lower.includes(needle)) return usd / MTOK;
  }
  return 0;
}

/**
 * Cache read bills at 0.1x the input rate, a 5m write at 1.25x and a 1h write at 2x.
 * Repricing those three at the plain input rate is what the same traffic would have
 * cost with caching switched off.
 */
function uncachedCostOf(e: UsageEvent): number {
  const rate = inputRate(e.model);
  return e.cost + rate * (0.9 * e.cacheRead - 0.25 * e.cacheWrite5m - e.cacheWrite1h);
}

function tokensOf(e: UsageEvent): number {
  return e.input + e.output + e.cacheRead + e.cacheWrite5m + e.cacheWrite1h;
}

function zero(): Totals {
  return {
    requests: 0,
    input: 0,
    output: 0,
    thinking: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWrite: 0,
    webSearch: 0,
    webFetch: 0,
    cost: 0,
    uncachedCost: 0,
    totalTokens: 0,
  };
}

const TOTALS_FIELDS = Object.keys(zero()) as Array<keyof Totals>;

function merge(into: Totals, from: Totals): void {
  for (const field of TOTALS_FIELDS) into[field] += from[field];
}

function add(t: Totals, e: UsageEvent): void {
  t.requests += 1;
  t.input += e.input;
  t.output += e.output;
  t.thinking += e.thinking;
  t.cacheRead += e.cacheRead;
  t.cacheWrite5m += e.cacheWrite5m;
  t.cacheWrite1h += e.cacheWrite1h;
  t.cacheWrite += e.cacheWrite5m + e.cacheWrite1h;
  t.webSearch += e.webSearch;
  t.webFetch += e.webFetch;
  t.cost += e.cost;
  t.uncachedCost += uncachedCostOf(e);
  t.totalTokens += tokensOf(e);
}

export function totals(events: readonly UsageEvent[]): Totals {
  const t = zero();
  for (const e of events) add(t, e);
  return t;
}

export function applyFilters(events: readonly UsageEvent[], filters: Filters): UsageEvent[] {
  const projects = filters.projects.length > 0 ? new Set(filters.projects) : null;
  const models = filters.models.length > 0 ? new Set(filters.models) : null;
  const skills = filters.skills.length > 0 ? new Set(filters.skills) : null;
  const scope = filters.agentScope;
  const out: UsageEvent[] = [];
  for (const e of events) {
    if (filters.from !== null && e.ts < filters.from) continue;
    if (filters.to !== null && e.ts > filters.to) continue;
    if (projects !== null && !projects.has(e.project)) continue;
    if (models !== null && !models.has(e.model)) continue;
    const skill = e.attributionSkill;
    if (skills !== null && (skill === null || !skills.has(skill))) continue;
    if (scope === 'main' && e.isSidechain) continue;
    if (scope === 'sub' && !e.isSidechain) continue;
    out.push(e);
  }
  return out;
}

function partsFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** The wall clock in `dtf`'s zone at `ts`, re-expressed as a UTC instant. */
function wallClockMs(dtf: Intl.DateTimeFormat, ts: number): number {
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of dtf.formatToParts(ts)) {
    const n = Number(part.value);
    if (part.type === 'year') year = n;
    else if (part.type === 'month') month = n;
    else if (part.type === 'day') day = n;
    else if (part.type === 'hour') hour = n === 24 ? 0 : n;
    else if (part.type === 'minute') minute = n;
    else if (part.type === 'second') second = n;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

type Clock = {
  /** UTC instant -> local wall clock as a UTC instant, so bucketing is plain arithmetic. */
  shift: (ts: number) => number;
  /** Inverse of `shift`, for turning a bucket boundary back into a real instant. */
  real: (shifted: number) => number;
};

function makeClock(timeZone: string | undefined): Clock {
  const dtf = partsFormatter(timeZone);
  const offsets = new Map<number, number>();
  const offsetAt = (ts: number): number => {
    // Every real UTC offset is a multiple of 15 minutes, so it is constant inside a slot.
    const slot = Math.floor(ts / 900_000);
    let off = offsets.get(slot);
    if (off === undefined) {
      off = wallClockMs(dtf, ts) - ts;
      offsets.set(slot, off);
    }
    return off;
  };
  return {
    shift: (ts) => ts + offsetAt(ts),
    real: (shifted) => shifted - offsetAt(shifted - offsetAt(shifted)),
  };
}

function isoDay(shifted: number): string {
  return new Date(shifted).toISOString().slice(0, 10);
}

function bucketed<R>(
  events: readonly UsageEvent[],
  timeZone: string | undefined,
  unit: number,
  build: (shifted: number, real: number, t: Totals) => R,
): R[] {
  const clock = makeClock(timeZone);
  const buckets = new Map<number, Totals>();
  let first = Infinity;
  let last = -Infinity;
  for (const e of events) {
    const start = Math.floor(clock.shift(e.ts) / unit) * unit;
    let t = buckets.get(start);
    if (t === undefined) {
      t = zero();
      buckets.set(start, t);
    }
    add(t, e);
    if (start < first) first = start;
    if (start > last) last = start;
  }
  if (buckets.size === 0) return [];
  const out: R[] = [];
  for (let start = first; start <= last; start += unit) {
    out.push(build(start, clock.real(start), buckets.get(start) ?? zero()));
  }
  return out;
}

export function byDay(
  events: readonly UsageEvent[],
  timeZone?: string,
): Array<{ day: string; ts: number } & Totals> {
  return bucketed(events, timeZone, DAY_MS, (shifted, real, t) => ({
    day: isoDay(shifted),
    ts: real,
    ...t,
  }));
}

export function byHour(
  events: readonly UsageEvent[],
  timeZone?: string,
): Array<{ ts: number } & Totals> {
  return bucketed(events, timeZone, HOUR_MS, (_shifted, real, t) => ({ ts: real, ...t }));
}

export function heatmap(
  events: readonly UsageEvent[],
  timeZone?: string,
): {
  cells: Array<{ day: string; dow: number; hour: number; tokens: number; cost: number }>;
  max: number;
} {
  const clock = makeClock(timeZone);
  const hours = new Map<number, { tokens: number; cost: number }>();
  let first = Infinity;
  let last = -Infinity;
  for (const e of events) {
    const shifted = clock.shift(e.ts);
    const hourStart = Math.floor(shifted / HOUR_MS) * HOUR_MS;
    let cell = hours.get(hourStart);
    if (cell === undefined) {
      cell = { tokens: 0, cost: 0 };
      hours.set(hourStart, cell);
    }
    cell.tokens += tokensOf(e);
    cell.cost += e.cost;
    const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
    if (dayStart < first) first = dayStart;
    if (dayStart > last) last = dayStart;
  }
  if (hours.size === 0) return { cells: [], max: 0 };
  const cells: Array<{ day: string; dow: number; hour: number; tokens: number; cost: number }> = [];
  let max = 0;
  for (let dayStart = first; dayStart <= last; dayStart += DAY_MS) {
    const day = isoDay(dayStart);
    const dow = new Date(dayStart).getUTCDay();
    for (let hour = 0; hour < 24; hour++) {
      const cell = hours.get(dayStart + hour * HOUR_MS);
      const tokens = cell?.tokens ?? 0;
      if (tokens > max) max = tokens;
      cells.push({ day, dow, hour, tokens, cost: cell?.cost ?? 0 });
    }
  }
  return { cells, max };
}

/** The collapsed tail row `groupBy` emits when `top` is smaller than the group count. */
const OTHER = '__other__';

/** Two thirds of requests carry no skill, so these rows are the baseline, not an anomaly. */
export const NO_SKILL = 'no skill loaded';
export const NO_PLUGIN = 'no plugin';

export function groupBy<K>(
  events: readonly UsageEvent[],
  keyFn: (e: UsageEvent) => K | null,
  opts?: { top?: number },
): Array<{ key: K | typeof OTHER; share: number } & Totals> {
  const groups = new Map<K, Totals>();
  for (const e of events) {
    const key = keyFn(e);
    if (key === null) continue;
    let t = groups.get(key);
    if (t === undefined) {
      t = zero();
      groups.set(key, t);
    }
    add(t, e);
  }
  const ranked: Array<{ key: K | typeof OTHER; t: Totals }> = [];
  for (const [key, t] of groups) ranked.push({ key, t });
  ranked.sort((a, b) => b.t.totalTokens - a.t.totalTokens);

  const top = opts?.top;
  let rows = ranked;
  if (top !== undefined && top > 0 && ranked.length > top) {
    const other = zero();
    for (let i = top; i < ranked.length; i++) {
      const tail = ranked[i];
      if (tail !== undefined) merge(other, tail.t);
    }
    rows = [...ranked.slice(0, top), { key: OTHER, t: other }];
  }

  let grand = 0;
  for (const row of rows) grand += row.t.totalTokens;
  return rows.map((row) => ({
    key: row.key,
    share: grand > 0 ? row.t.totalTokens / grand : 0,
    ...row.t,
  }));
}

export function byModel(events: readonly UsageEvent[], opts?: { top?: number }) {
  return groupBy(events, (e) => e.model, opts);
}

export function byProject(events: readonly UsageEvent[], opts?: { top?: number }) {
  return groupBy(events, (e) => e.project, opts);
}

export function byAgent(events: readonly UsageEvent[], opts?: { top?: number }) {
  return groupBy(
    events,
    (e) => (e.isSidechain ? (e.attributionAgent ?? 'subagent (untagged)') : 'main thread'),
    opts,
  );
}

export function bySkill(events: readonly UsageEvent[], opts?: { top?: number }) {
  return groupBy(events, (e) => e.attributionSkill ?? NO_SKILL, opts);
}

export function byPlugin(events: readonly UsageEvent[], opts?: { top?: number }) {
  return groupBy(events, (e) => e.attributionPlugin ?? NO_PLUGIN, opts);
}

export function byEffort(events: readonly UsageEvent[], opts?: { top?: number }) {
  return groupBy(events, (e) => e.effort, opts);
}

export function byBranch(events: readonly UsageEvent[], opts?: { top?: number }) {
  return groupBy(events, (e) => e.gitBranch, opts);
}

export function byVersion(events: readonly UsageEvent[], opts?: { top?: number }) {
  return groupBy(events, (e) => e.version, opts);
}

/**
 * A tool row. `calls` is the tool grain; the cost and token figures belong to the
 * requests that made those calls, which is why they are named for the request.
 *
 * Those two are NOT additive down a column. A request that calls Bash, Read and Edit
 * lands its full cost in all three rows, so the rows sum past the filtered total and
 * the shares past 100%. Only `calls`, `share` and the group's own `requests` add up.
 */
export type ToolTotals = {
  calls: number;
  /** Distinct requests that made at least one of these calls. */
  requests: number;
  requestCost: number;
  requestTokens: number;
};

/**
 * Joins tool calls to the events they were made by, which is the only path filters have
 * to the tool grain: a call whose request is not in `events` is dropped, so passing an
 * already-filtered event list filters the tools too.
 */
function groupTools<K>(
  toolCalls: readonly ToolCall[],
  events: readonly UsageEvent[],
  keyFn: (name: string) => K | null,
  opts?: { top?: number },
): Array<{ key: K | typeof OTHER; share: number } & ToolTotals> {
  const index = new Map<string, UsageEvent>();
  for (const e of events) index.set(e.requestId, e);

  const groups = new Map<K, { calls: number; requests: Set<string> }>();
  for (const call of toolCalls) {
    if (!index.has(call.requestId)) continue;
    const key = keyFn(call.name);
    if (key === null) continue;
    let g = groups.get(key);
    if (g === undefined) {
      g = { calls: 0, requests: new Set() };
      groups.set(key, g);
    }
    g.calls += 1;
    g.requests.add(call.requestId);
  }

  const ranked: Array<{ key: K | typeof OTHER; calls: number; requests: Set<string> }> = [];
  for (const [key, g] of groups) ranked.push({ key, calls: g.calls, requests: g.requests });
  ranked.sort((a, b) => b.calls - a.calls);

  const top = opts?.top;
  let rows = ranked;
  if (top !== undefined && top > 0 && ranked.length > top) {
    // The tail's request sets are unioned rather than summed, because one request can
    // call two different tail tools and would otherwise be counted twice.
    const requests = new Set<string>();
    let calls = 0;
    for (let i = top; i < ranked.length; i++) {
      const tail = ranked[i];
      if (tail === undefined) continue;
      calls += tail.calls;
      for (const requestId of tail.requests) requests.add(requestId);
    }
    rows = [...ranked.slice(0, top), { key: OTHER, calls, requests }];
  }

  let grand = 0;
  for (const row of rows) grand += row.calls;
  return rows.map((row) => {
    let requestCost = 0;
    let requestTokens = 0;
    for (const requestId of row.requests) {
      const e = index.get(requestId);
      if (e === undefined) continue;
      requestCost += e.cost;
      requestTokens += tokensOf(e);
    }
    return {
      key: row.key,
      share: grand > 0 ? row.calls / grand : 0,
      calls: row.calls,
      requests: row.requests.size,
      requestCost,
      requestTokens,
    };
  });
}

export function byTool(
  toolCalls: readonly ToolCall[],
  events: readonly UsageEvent[],
  opts?: { top?: number },
) {
  return groupTools(toolCalls, events, (name) => name, opts);
}

export function byMcpServer(
  toolCalls: readonly ToolCall[],
  events: readonly UsageEvent[],
  opts?: { top?: number },
) {
  return groupTools(toolCalls, events, (name) => mcpTarget(name)?.server ?? null, opts);
}

/** The counts a tool panel needs for its headings, over the same join as `byTool`. */
export function toolMix(
  toolCalls: readonly ToolCall[],
  events: readonly UsageEvent[],
): { calls: number; requests: number; tools: number; mcpCalls: number; mcpServers: number } {
  const known = new Set<string>();
  for (const e of events) known.add(e.requestId);

  const requests = new Set<string>();
  const tools = new Set<string>();
  const mcpServers = new Set<string>();
  let calls = 0;
  let mcpCalls = 0;
  for (const call of toolCalls) {
    if (!known.has(call.requestId)) continue;
    calls += 1;
    requests.add(call.requestId);
    tools.add(call.name);
    const target = mcpTarget(call.name);
    if (target !== null) {
      mcpCalls += 1;
      mcpServers.add(target.server);
    }
  }
  return {
    calls,
    requests: requests.size,
    tools: tools.size,
    mcpCalls,
    mcpServers: mcpServers.size,
  };
}

export type SessionRow = {
  sessionId: string;
  slug: string | null;
  project: string;
  gitBranch: string | null;
  firstTs: number;
  lastTs: number;
  durationMs: number;
  models: string[];
  reportedCost: number | null;
} & Totals;

export function sessions(
  events: readonly UsageEvent[],
  sessionCosts: readonly SessionCost[],
): SessionRow[] {
  const reported = new Map<string, number>();
  for (const c of sessionCosts) reported.set(c.sessionId, c.totalCostUSD);

  type Acc = {
    row: SessionRow;
    modelTokens: Map<string, number>;
  };
  const accs = new Map<string, Acc>();
  for (const e of events) {
    let acc = accs.get(e.sessionId);
    if (acc === undefined) {
      acc = {
        row: {
          sessionId: e.sessionId,
          slug: e.slug,
          project: e.project,
          gitBranch: e.gitBranch,
          firstTs: e.ts,
          lastTs: e.ts,
          durationMs: 0,
          models: [],
          reportedCost: reported.get(e.sessionId) ?? null,
          ...zero(),
        },
        modelTokens: new Map(),
      };
      accs.set(e.sessionId, acc);
    }
    const { row } = acc;
    add(row, e);
    if (e.ts < row.firstTs) row.firstTs = e.ts;
    if (e.ts > row.lastTs) row.lastTs = e.ts;
    if (row.slug === null) row.slug = e.slug;
    if (row.gitBranch === null) row.gitBranch = e.gitBranch;
    acc.modelTokens.set(e.model, (acc.modelTokens.get(e.model) ?? 0) + tokensOf(e));
  }

  const rows: SessionRow[] = [];
  for (const acc of accs.values()) {
    acc.row.durationMs = acc.row.lastTs - acc.row.firstTs;
    acc.row.models = [...acc.modelTokens.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([model]) => model);
    rows.push(acc.row);
  }
  rows.sort((a, b) => b.lastTs - a.lastTs);
  return rows;
}

/** A stretch of one session's requests that ran with no human turn inside it. */
export type Run = {
  sessionId: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  requests: number;
  cost: number;
  tokens: number;
};

/**
 * Silence this long ends a run.
 *
 * The answer moves with this number, so it is stated rather than tuned: the longest run in
 * the measured window is 3.21h at a 5- or 10-minute cut and 7.82h from 30 minutes out to an
 * hour. That is why the panel prints a run's request count beside its duration. With no cut
 * at all the longest stretch is 84.55h over 4 requests, 84.53h of which is a single idle gap.
 * Of the window's 31,428 inter-request gaps only 79 exceed 30 minutes, a quarter of one
 * percent, so a 30-minute cut splits abandonment rather than work.
 *
 * It is deliberately not the prompt-cache TTL. Every cache write in the measured window is
 * 1-hour ephemeral, so the 5-minute TTL is not the clock this is measuring against.
 */
const IDLE_CUT_MS = 1_800_000;

/** Index of the greatest value in `sorted` at or before `ts`, or -1 when there is none. */
function lastAtOrBefore(sorted: readonly number[], ts: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Every unattended run, oldest first. A run starts at the most recent human turn at or
 * before its first request when that turn is inside the cut, otherwise at the first request
 * itself, and ends at its last request. Runs never cross sessions.
 *
 * Human turns are boundary markers, not events, so they are NOT subject to the global filter
 * bar: `events` is whatever the caller filtered, `humanTurns` is the unfiltered list. A
 * filtered turn list would drop the boundary a person actually typed and fuse two runs into
 * one long stretch the agent never ran alone.
 */
export function runs(events: readonly UsageEvent[], humanTurns: readonly HumanTurn[]): Run[] {
  const requestsBySession = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const list = requestsBySession.get(e.sessionId);
    if (list === undefined) requestsBySession.set(e.sessionId, [e]);
    else list.push(e);
  }

  const turnsBySession = new Map<string, number[]>();
  for (const turn of humanTurns) {
    const list = turnsBySession.get(turn.sessionId);
    if (list === undefined) turnsBySession.set(turn.sessionId, [turn.ts]);
    else list.push(turn.ts);
  }

  const out: Run[] = [];
  for (const [sessionId, list] of requestsBySession) {
    const requests = [...list].sort((a, b) => a.ts - b.ts);
    const turns = (turnsBySession.get(sessionId) ?? []).sort((a, b) => a - b);

    let startTs = 0;
    let prev: number | null = null;
    let count = 0;
    let cost = 0;
    let tokens = 0;

    const emit = () => {
      if (prev === null) return;
      out.push({
        sessionId,
        startTs,
        endTs: prev,
        durationMs: prev - startTs,
        requests: count,
        cost,
        tokens,
      });
    };

    for (const e of requests) {
      const at = lastAtOrBefore(turns, e.ts);
      const latest = at < 0 ? null : turns[at]!;
      const typedSince = latest !== null && (prev === null || latest > prev);
      if (prev === null || e.ts - prev > IDLE_CUT_MS || typedSince) {
        emit();
        const opener = typedSince ? latest : null;
        startTs = opener !== null && e.ts - opener <= IDLE_CUT_MS ? opener : e.ts;
        count = 0;
        cost = 0;
        tokens = 0;
      }
      count += 1;
      cost += e.cost;
      tokens += tokensOf(e);
      prev = e.ts;
    }
    emit();
  }

  out.sort((a, b) => a.startTs - b.startTs);
  return out;
}

export type SessionStats = {
  sessions: number;
  meanSessionMs: number;
  medianSessionMs: number;
  longestSession: SessionRow | null;
  runs: number;
  medianRunMs: number;
  longestRun: Run | null;
};

/**
 * The headline numbers above the session table. Both the mean and the median are reported
 * because they disagree by more than an order of magnitude: sessions left open for days
 * drag the mean to 3.99h against a median of 0.17h.
 */
export function sessionStats(
  events: readonly UsageEvent[],
  sessionCosts: readonly SessionCost[],
  humanTurns: readonly HumanTurn[],
): SessionStats {
  const rows = sessions(events, sessionCosts);
  const stretches = runs(events, humanTurns);

  let totalMs = 0;
  let longestSession: SessionRow | null = null;
  for (const row of rows) {
    totalMs += row.durationMs;
    if (longestSession === null || row.durationMs > longestSession.durationMs) {
      longestSession = row;
    }
  }

  let longestRun: Run | null = null;
  for (const run of stretches) {
    if (longestRun === null || run.durationMs > longestRun.durationMs) longestRun = run;
  }

  return {
    sessions: rows.length,
    meanSessionMs: rows.length > 0 ? totalMs / rows.length : 0,
    medianSessionMs: median(rows.map((row) => row.durationMs)),
    longestSession,
    runs: stretches.length,
    medianRunMs: median(stretches.map((run) => run.durationMs)),
    longestRun,
  };
}

export function burnRate(
  events: readonly UsageEvent[],
  now: number,
  windowMs: number,
): {
  tokensPerMin: number;
  costPerHour: number;
  requestsPerMin: number;
  projectedTokensToday: number;
  projectedCostToday: number;
} {
  const windowStart = now - windowMs;
  const clock = makeClock(undefined);
  const dayStart = clock.real(Math.floor(clock.shift(now) / DAY_MS) * DAY_MS);

  let windowTokens = 0;
  let windowCost = 0;
  let windowRequests = 0;
  let todayTokens = 0;
  let todayCost = 0;
  for (const e of events) {
    if (e.ts >= windowStart && e.ts <= now) {
      windowTokens += tokensOf(e);
      windowCost += e.cost;
      windowRequests += 1;
    }
    if (e.ts >= dayStart && e.ts <= now) {
      todayTokens += tokensOf(e);
      todayCost += e.cost;
    }
  }

  const minutes = windowMs / 60_000;
  // Projecting from the burn window would swing wildly; today's elapsed hours are
  // the honest base. The 1-hour floor caps the multiplier at 24x just after midnight.
  const elapsedHours = Math.max((now - dayStart) / HOUR_MS, 1);
  const dayScale = 24 / elapsedHours;
  return {
    tokensPerMin: minutes > 0 ? windowTokens / minutes : 0,
    costPerHour: windowMs > 0 ? windowCost / (windowMs / HOUR_MS) : 0,
    requestsPerMin: minutes > 0 ? windowRequests / minutes : 0,
    projectedTokensToday: todayTokens * dayScale,
    projectedCostToday: todayCost * dayScale,
  };
}

export function cacheStats(events: readonly UsageEvent[]): {
  hitRatio: number;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  split5m: number;
  split1h: number;
  savingsUSD: number;
  savingsRatio: number;
} {
  const t = totals(events);
  const inputSide = t.input + t.cacheRead + t.cacheWrite;
  const savingsUSD = t.uncachedCost - t.cost;
  return {
    hitRatio: inputSide > 0 ? t.cacheRead / inputSide : 0,
    freshInput: t.input,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    split5m: t.cacheWrite > 0 ? t.cacheWrite5m / t.cacheWrite : 0,
    split1h: t.cacheWrite > 0 ? t.cacheWrite1h / t.cacheWrite : 0,
    savingsUSD,
    savingsRatio: t.uncachedCost > 0 ? savingsUSD / t.uncachedCost : 0,
  };
}

export function median(ns: number[]): number {
  if (ns.length === 0) return 0;
  const sorted = [...ns].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return hi;
  return (hi + (sorted[mid - 1] ?? 0)) / 2;
}

export function dailyMedian(rows: readonly Totals[], field: keyof Totals): number {
  return median(rows.map((r) => r[field]));
}

export function recentFeed(events: readonly UsageEvent[], n: number): UsageEvent[] {
  if (n <= 0) return [];
  return [...events].sort((a, b) => b.ts - a.ts).slice(0, n);
}

function keysByVolume(
  events: readonly UsageEvent[],
  pick: (e: UsageEvent) => string | null,
): string[] {
  const volume = new Map<string, number>();
  for (const e of events) {
    const key = pick(e);
    if (key === null) continue;
    volume.set(key, (volume.get(key) ?? 0) + tokensOf(e));
  }
  return [...volume.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

export function distinctProjects(events: readonly UsageEvent[]): string[] {
  return keysByVolume(events, (e) => e.project);
}

export function distinctModels(events: readonly UsageEvent[]): string[] {
  return keysByVolume(events, (e) => e.model);
}

export function distinctSkills(events: readonly UsageEvent[]): string[] {
  return keysByVolume(events, (e) => e.attributionSkill);
}
