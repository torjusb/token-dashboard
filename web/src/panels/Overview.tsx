import { useMemo, useState } from 'react';
import { TOKEN_KINDS, type TokenKind, type UsageEvent } from '../../../shared/types.ts';
import { AreaChart, Heatmap, Sparkline, type ChartSeries, type HeatCell } from '../charts/index.ts';
import { useFilters } from '../lib/filters.tsx';
import {
  TOKEN_KIND_LABELS,
  colorForTokenKind,
  formatCompact,
  formatCost,
  formatCostCompact,
  formatCount,
  formatDayLabel,
  formatPercent,
  formatRelative,
} from '../lib/format.ts';
import {
  burnRate,
  byDay,
  dailyMedian,
  heatmap,
  median,
  totals,
  type Totals,
} from '../lib/select.ts';
import type { StreamStatus } from '../lib/stream.ts';

type DayRow = { day: string; ts: number; sessions: number } & Totals;

const BURN_WINDOW_MS = 3_600_000;
const STALE_MS = 120_000;

const EMPTY_DAY: DayRow = { day: '', ts: 0, sessions: 0, ...totals([]) };

function localDay(ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function dayRows(events: readonly UsageEvent[]): DayRow[] {
  const ids = new Map<string, Set<string>>();
  for (const e of events) {
    const key = localDay(e.ts);
    let set = ids.get(key);
    if (set === undefined) {
      set = new Set();
      ids.set(key, set);
    }
    set.add(e.sessionId);
  }
  return byDay(events).map((row) => ({ ...row, sessions: ids.get(row.day)?.size ?? 0 }));
}

type TileSpec = {
  key: string;
  label: string;
  pick: (row: DayRow) => number;
  baseline: (rows: readonly DayRow[]) => number;
  format: (n: number) => string;
  color: string;
};

const TILES: readonly TileSpec[] = [
  {
    key: 'tokens',
    label: 'Tokens today',
    pick: (r) => r.totalTokens,
    baseline: (rows) => dailyMedian(rows, 'totalTokens'),
    format: formatCompact,
    color: 'var(--series-1)',
  },
  {
    key: 'cost',
    label: 'Cost today',
    pick: (r) => r.cost,
    baseline: (rows) => dailyMedian(rows, 'cost'),
    format: formatCostCompact,
    color: 'var(--series-2)',
  },
  {
    key: 'requests',
    label: 'Requests today',
    pick: (r) => r.requests,
    baseline: (rows) => dailyMedian(rows, 'requests'),
    format: formatCount,
    color: 'var(--series-3)',
  },
  {
    key: 'sessions',
    label: 'Sessions today',
    pick: (r) => r.sessions,
    baseline: (rows) => median(rows.map((r) => r.sessions)),
    format: formatCount,
    color: 'var(--series-7)',
  },
];

function compare(
  today: number,
  baseline: number,
  days: number,
): { text: string; tone: 'up' | 'down' | 'flat' } {
  if (days === 0 || baseline <= 0) return { text: 'no median day yet', tone: 'flat' };
  const ratio = today / baseline - 1;
  const suffix = `vs ${days}d median`;
  if (Math.abs(ratio) < 0.005) return { text: `at median, ${suffix}`, tone: 'flat' };
  const sign = ratio > 0 ? '+' : '-';
  return {
    text: `${sign}${formatPercent(Math.abs(ratio))} ${suffix}`,
    tone: ratio > 0 ? 'up' : 'down',
  };
}

function freshness(
  status: StreamStatus,
  lastEventAt: number | null,
  now: number,
): { tone: '' | ' stale' | ' offline'; text: string } {
  if (status === 'connecting') return { tone: ' offline', text: 'Connecting to the stream' };
  if (status === 'reconnecting') return { tone: ' stale', text: 'Reconnecting to the stream' };
  if (status === 'error') return { tone: ' offline', text: 'Stream down, still retrying' };
  if (lastEventAt === null) return { tone: ' stale', text: 'Connected, nothing recorded yet' };
  const relative = formatRelative(lastEventAt, now);
  if (now - lastEventAt < STALE_MS) return { tone: '', text: `Live, last request ${relative}` };
  return { tone: ' stale', text: `Idle, last request ${relative}` };
}

function emptyState(
  status: StreamStatus,
  backfilling: boolean,
  eventCount: number,
): { title: string; hint: string } {
  if (eventCount > 0) {
    return {
      title: 'No requests match the current filters',
      hint: 'Widen the date range, or clear the project, model and agent filters.',
    };
  }
  if (backfilling) {
    return {
      title: 'Reading 30 days of transcript history',
      hint: 'Tiles and charts fill in as the backfill commits to the store.',
    };
  }
  if (status === 'connecting') {
    return {
      title: 'Connecting to the usage stream',
      hint: 'The dashboard server should be listening on 127.0.0.1:4317.',
    };
  }
  if (status === 'reconnecting' || status === 'error') {
    return {
      title: 'Cannot reach the usage stream',
      hint: 'Retrying on a backoff. Check that the server is still running.',
    };
  }
  return {
    title: 'No usage in the last 30 days',
    hint: 'Nothing under ~/.claude/projects falls inside the window.',
  };
}

type ChartView = {
  key: string;
  label: string;
  caption: string;
  stacked: boolean;
  yScale: 'linear' | 'log';
  formatY: (n: number) => string;
  series: (rows: readonly DayRow[]) => ChartSeries[];
};

function kindSeries(rows: readonly DayRow[], kinds: readonly TokenKind[]): ChartSeries[] {
  return kinds.map((kind) => ({
    key: kind,
    label: TOKEN_KIND_LABELS[kind],
    color: colorForTokenKind(kind),
    points: rows.map((r) => ({ x: r.ts, y: r[kind] })),
  }));
}

const STACK_KINDS: readonly TokenKind[] = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h'];

const LOG_VIEW: ChartView = {
  key: 'log',
  label: 'Tokens, log',
  caption:
    'All five kinds on a log axis, unstacked. Cache reads run roughly 40x the rest, so a raw linear stack buries input and output in the baseline. A break in a line is a day with none of that kind, which a log axis cannot place; switch to stacked to see those days sit on zero.',
  stacked: false,
  yScale: 'log',
  formatY: formatCompact,
  series: (rows) => kindSeries(rows, TOKEN_KINDS),
};

const STACKED_VIEW: ChartView = {
  key: 'stacked',
  label: 'Tokens, stacked',
  caption: 'Cache read is excluded so the four remaining kinds keep a readable share of the stack.',
  stacked: true,
  yScale: 'linear',
  formatY: formatCompact,
  series: (rows) => kindSeries(rows, STACK_KINDS),
};

const COST_VIEW: ChartView = {
  key: 'cost',
  label: 'Cost',
  caption:
    'Daily spend as priced by the server. Not split by token kind, because the per-kind rates live server-side.',
  stacked: false,
  yScale: 'linear',
  formatY: formatCostCompact,
  series: (rows) => [
    {
      key: 'cost',
      label: 'Cost',
      color: 'var(--series-2)',
      points: rows.map((r) => ({ x: r.ts, y: r.cost })),
    },
  ],
};

const CHART_VIEWS: readonly ChartView[] = [LOG_VIEW, STACKED_VIEW, COST_VIEW];

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

function weekGrid(events: readonly UsageEvent[]): HeatCell[] {
  const sums = new Map<number, number>();
  for (const cell of heatmap(events).cells) {
    const key = ((cell.dow + 6) % 7) * 24 + cell.hour;
    sums.set(key, (sums.get(key) ?? 0) + cell.tokens);
  }
  const cells: HeatCell[] = [];
  for (let row = 0; row < DOW_LABELS.length; row++) {
    for (let hour = 0; hour < 24; hour++) {
      cells.push({ row, col: hour, value: sums.get(row * 24 + hour) ?? 0 });
    }
  }
  return cells;
}

const STAT_STYLE = { fontVariantNumeric: 'tabular-nums' } as const;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span className="tile-label">{label}</span>
      <span style={{ ...STAT_STYLE, fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>
        {value}
      </span>
      {note === undefined ? null : (
        <span className="muted" style={{ fontSize: 11 }}>
          {note}
        </span>
      )}
    </div>
  );
}

export type OverviewProps = {
  events: readonly UsageEvent[];
  serverNow: number;
  status: StreamStatus;
  lastEventAt: number | null;
  backfilling: boolean;
  eventCount: number;
};

export function Overview({
  events,
  serverNow,
  status,
  lastEventAt,
  backfilling,
  eventCount,
}: OverviewProps) {
  const { isDefault } = useFilters();
  const [view, setView] = useState<ChartView>(LOG_VIEW);

  const rows = useMemo(() => dayRows(events), [events]);
  const cells = useMemo(() => weekGrid(events), [events]);
  const series = useMemo(() => view.series(rows), [view, rows]);
  const burn = useMemo(
    () => burnRate(events, serverNow, BURN_WINDOW_MS),
    [events, serverNow],
  );

  const todayKey = localDay(serverNow);
  const today = rows.find((r) => r.day === todayKey) ?? EMPTY_DAY;
  const baselineRows = useMemo(() => rows.filter((r) => r.day !== todayKey), [rows, todayKey]);

  const pulse = freshness(status, lastEventAt, serverNow);

  const strip = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--sp-3)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        <span className={`live-dot${pulse.tone}`} aria-hidden="true" />
        <span style={{ fontWeight: 600 }}>{pulse.text}</span>
      </span>
      <span
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', ...STAT_STYLE }}
        className="secondary"
      >
        {backfilling ? <span className="pill pill-warning">Loading history</span> : null}
        <span>
          {formatCount(events.length)} requests in view
          {isDefault ? '' : ` of ${formatCount(eventCount)}`}
        </span>
      </span>
    </div>
  );

  if (events.length === 0) {
    const state = emptyState(status, backfilling, eventCount);
    return (
      <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
        {strip}
        <div className="card" style={{ display: 'grid', gap: 'var(--sp-2)' }}>
          <h2>{state.title}</h2>
          <p className="secondary" style={{ margin: 0 }}>
            {state.hint}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
      {strip}

      <div className="grid-tiles">
        {TILES.map((tile) => {
          const value = tile.pick(today);
          const delta = compare(value, tile.baseline(baselineRows), baselineRows.length);
          return (
            <div className="tile" key={tile.key}>
              <span className="tile-label">{tile.label}</span>
              <span className="tile-value">{tile.format(value)}</span>
              <Sparkline
                values={rows.map(tile.pick)}
                color={tile.color}
                height={28}
                formatValue={tile.format}
                ariaLabel={`${tile.label}, ${rows.length} day trend, today ${tile.format(value)}, ${delta.text}`}
              />
              <span className={`tile-delta ${delta.tone}`}>{delta.text}</span>
            </div>
          );
        })}
      </div>

      <section className="card">
        <div className="card-header">
          <h2>Burn rate</h2>
          <span className="muted" style={{ fontSize: 11 }}>
            rolling 60 minutes
          </span>
        </div>
        <div
          style={{
            display: 'grid',
            gap: 'var(--sp-4)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          }}
        >
          <Stat label="Tokens / min" value={formatCompact(burn.tokensPerMin)} />
          <Stat label="Cost / hour" value={formatCost(burn.costPerHour)} />
          <Stat label="Requests / min" value={burn.requestsPerMin.toFixed(1)} />
          <Stat
            label="Projected today"
            value={`${formatCompact(burn.projectedTokensToday)} · ${formatCost(burn.projectedCostToday)}`}
            note="projection"
          />
        </div>
        <p className="muted" style={{ margin: 'var(--sp-3) 0 0', fontSize: 11 }}>
          The projection scales today's usage so far by the hours left in the local day. It is an
          extrapolation, not a measurement. Every cost here is a lower bound: the transcripts
          account for about 93% of what Claude Code reports billing, because it charges for
          internal calls it never writes to a transcript. Run <code>npm run validate</code> for
          the current coverage figure.
        </p>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Last {rows.length} days</h2>
          <div
            role="group"
            aria-label="Chart view"
            style={{
              display: 'flex',
              gap: 2,
              padding: 2,
              background: 'var(--surface-hover)',
              borderRadius: 'var(--r-md)',
            }}
          >
            {CHART_VIEWS.map((option) => {
              const active = option.key === view.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setView(option)}
                  style={{
                    border: 'none',
                    borderRadius: 'var(--r-sm)',
                    padding: '3px 10px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    color: active ? 'var(--text)' : 'var(--text-secondary)',
                    background: active ? 'var(--surface-raised)' : 'transparent',
                    boxShadow: active ? 'var(--shadow-1)' : 'none',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
        <AreaChart
          series={series}
          height={260}
          stacked={view.stacked}
          yScale={view.yScale}
          formatY={view.formatY}
          formatX={formatDayLabel}
        />
        <p className="muted" style={{ margin: 'var(--sp-3) 0 0', fontSize: 11 }}>
          {view.caption}
        </p>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>When the tokens go</h2>
          <span className="muted" style={{ fontSize: 11 }}>
            local hour by weekday, summed over the window
          </span>
        </div>
        <Heatmap
          cells={cells}
          rowLabels={DOW_LABELS}
          colLabels={HOUR_LABELS}
          ramping="sqrt"
          legendLabel="Tokens"
        />
      </section>
    </div>
  );
}
