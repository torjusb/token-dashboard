import { useMemo, useState } from 'react';
import { TOKEN_KINDS, type SessionCost, type UsageEvent } from '../../../shared/types.ts';
import { AreaChart, Donut, type ChartPoint, type DonutSegment } from '../charts/index.ts';
import { useFilters, type Filters } from '../lib/filters.tsx';
import {
  TOKEN_KIND_LABELS,
  colorForModel,
  colorForTokenKind,
  formatCompact,
  formatCost,
  formatCount,
  formatDateTime,
  formatDayLabel,
  formatDuration,
  formatPercent,
  formatTimeLabel,
  modelLabel,
} from '../lib/format.ts';
import { applyFilters, byModel, sessions, totals, type SessionRow } from '../lib/select.ts';

export type SessionsProps = {
  events: readonly UsageEvent[];
  sessionCosts: readonly SessionCost[];
};

const DRIFT_LIMIT = 0.1;

type SortKey = 'firstTs' | 'durationMs' | 'requests' | 'totalTokens' | 'cost' | 'reportedCost' | 'drift';

type Sort = { key: SortKey; dir: 'asc' | 'desc' };

type Column = {
  id: string;
  label: string;
  num: boolean;
  sort: SortKey | null;
  hint?: string;
};

const COLUMNS: readonly Column[] = [
  { id: 'session', label: 'Session', num: false, sort: null },
  { id: 'project', label: 'Project', num: false, sort: null },
  { id: 'started', label: 'Started', num: false, sort: 'firstTs' },
  { id: 'duration', label: 'Duration', num: true, sort: 'durationMs' },
  { id: 'models', label: 'Model mix', num: false, sort: null },
  { id: 'requests', label: 'Req', num: true, sort: 'requests' },
  { id: 'tokens', label: 'Tokens', num: true, sort: 'totalTokens' },
  { id: 'cost', label: 'Derived', num: true, sort: 'cost', hint: 'Cost from this dashboard’s pricing table' },
  { id: 'reported', label: 'Reported', num: true, sort: 'reportedCost', hint: 'Claude Code’s own cost-state total for the session' },
  { id: 'drift', label: 'Δ', num: true, sort: 'drift', hint: 'Derived minus reported, as a share of reported' },
];

function drift(row: SessionRow): number | null {
  if (row.reportedCost === null || row.reportedCost <= 0) return null;
  return (row.cost - row.reportedCost) / row.reportedCost;
}

function sortValue(row: SessionRow, key: SortKey): number {
  if (key === 'drift') {
    const d = drift(row);
    return d === null ? -Infinity : Math.abs(d);
  }
  if (key === 'reportedCost') return row.reportedCost ?? -Infinity;
  return row[key];
}

const BUCKET_MS = [10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000];

/**
 * Half the sessions here run under ten minutes, so `byHour` would collapse most of
 * them to a single point. The bucket is picked from the session's own span instead.
 */
function requestTimeline(events: readonly UsageEvent[]): ChartPoint[] {
  if (events.length === 0) return [];
  let first = Infinity;
  let last = -Infinity;
  for (const e of events) {
    if (e.ts < first) first = e.ts;
    if (e.ts > last) last = e.ts;
  }
  const unit = BUCKET_MS.find((u) => u >= Math.max(last - first, 1) / 30) ?? 86_400_000;
  const counts = new Map<number, number>();
  for (const e of events) {
    const slot = Math.floor(e.ts / unit) * unit;
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  const points: ChartPoint[] = [];
  for (let x = Math.floor(first / unit) * unit; x <= last; x += unit) {
    points.push({ x, y: counts.get(x) ?? 0 });
  }
  return points;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function relaxable(f: Filters): string[] {
  const notes: string[] = [];
  if (f.from !== null || f.to !== null) {
    const from = f.from === null ? 'the start of the window' : formatDayLabel(f.from);
    const to = f.to === null ? 'now' : formatDayLabel(f.to);
    notes.push(`the date range, ${from} to ${to}`);
  }
  if (f.projects.length > 0) notes.push(`${plural(f.projects.length, 'project')} (${f.projects.join(', ')})`);
  if (f.models.length > 0) {
    notes.push(`${plural(f.models.length, 'model')} (${f.models.map(modelLabel).join(', ')})`);
  }
  if (f.agentScope === 'main') notes.push('main-thread traffic only');
  if (f.agentScope === 'sub') notes.push('subagent traffic only');
  return notes;
}

const headButton = (num: boolean) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  flexDirection: (num ? 'row-reverse' : 'row') as 'row' | 'row-reverse',
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit' as const,
});

const clipped = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

function ModelMix({ mix }: { mix: ReadonlyArray<{ key: string; share: number }> }) {
  const dominant = mix[0];
  if (dominant === undefined) return <span className="muted">–</span>;
  const label = (
    <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
      {modelLabel(dominant.key)}
      {mix.length > 1 ? <span className="muted"> +{mix.length - 1}</span> : null}
    </span>
  );

  // A single-model session is 8 rows in 10 here, and a bar always at 100% says nothing.
  if (mix.length === 1) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span className="swatch" style={{ background: colorForModel(dominant.key) }} />
        {label}
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 78 }}>
      <div
        style={{ display: 'flex', gap: 2, height: 6 }}
        title={mix.map((m) => `${modelLabel(m.key)} ${formatPercent(m.share, 0)}`).join(', ')}
      >
        {mix.map((m) => (
          <div
            key={m.key}
            style={{
              flex: `${Math.max(m.share, 0.02)} 1 0`,
              background: colorForModel(m.key),
              borderRadius: 3,
            }}
          />
        ))}
      </div>
      {label}
    </div>
  );
}

function DriftCell({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">–</span>;
  const off = Math.abs(value) > DRIFT_LIMIT;
  const sign = value > 0 ? '+' : '';
  return (
    <span className={off ? 'pill pill-warning' : 'pill'}>
      {sign}
      {formatPercent(value, 0)}
    </span>
  );
}

function SessionDetail({
  row,
  events,
  mix,
}: {
  row: SessionRow;
  events: readonly UsageEvent[];
  mix: ReadonlyArray<{ key: string; share: number; totalTokens: number }>;
}) {
  const points = useMemo(() => requestTimeline(events), [events]);
  const t = useMemo(() => totals(events), [events]);
  const segments: DonutSegment[] = TOKEN_KINDS.map((kind) => ({
    key: kind,
    label: TOKEN_KIND_LABELS[kind],
    value: t[kind],
    color: colorForTokenKind(kind),
  }));
  const d = drift(row);

  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sp-4)',
        gridTemplateColumns: 'minmax(260px, 2fr) minmax(200px, 1fr)',
        padding: 'var(--sp-3) 0 var(--sp-4)',
      }}
    >
      <div
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--sp-3)',
          alignItems: 'center',
          fontSize: 12,
        }}
      >
        <code className="muted">{row.sessionId}</code>
        <span className="muted">·</span>
        <span className="secondary">{row.gitBranch ?? 'no branch'}</span>
        <span className="muted">·</span>
        <span className="secondary">
          {formatCost(row.cost)} derived
          {row.reportedCost === null
            ? ', no cost-state line yet'
            : `, ${formatCost(row.reportedCost)} reported`}
        </span>
        {d !== null && Math.abs(d) > DRIFT_LIMIT ? (
          <span className="pill pill-warning">
            pricing drift {d > 0 ? '+' : ''}
            {formatPercent(d, 0)}
          </span>
        ) : null}
        <span className="muted">·</span>
        <span className="secondary">
          thinking {formatPercent(t.output > 0 ? t.thinking / t.output : 0, 0)} of output
        </span>
      </div>

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div>
          <h3 style={{ marginBottom: 'var(--sp-2)' }}>Requests over time</h3>
          <AreaChart
            series={[{ key: 'requests', label: 'Requests', color: 'var(--series-1)', points }]}
            height={180}
            formatY={formatCount}
            formatX={formatTimeLabel}
            emptyMessage="No requests in this session"
          />
        </div>
        <div>
          <h3 style={{ marginBottom: 'var(--sp-2)' }}>Models</h3>
          <ul
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px 16px',
              listStyle: 'none',
              margin: 0,
              padding: 0,
              fontSize: 12,
            }}
          >
            {mix.map((m) => (
              <li key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="swatch" style={{ background: colorForModel(m.key) }} />
                <span>{modelLabel(m.key)}</span>
                <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatCompact(m.totalTokens)} · {formatPercent(m.share, 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        <h3 style={{ marginBottom: 'var(--sp-2)' }}>Token composition</h3>
        <Donut
          segments={segments}
          size={168}
          thickness={22}
          centerValue={formatCompact(t.totalTokens)}
          centerLabel="tokens"
          formatValue={formatCompact}
        />
      </div>
    </div>
  );
}

export function Sessions({ events, sessionCosts }: SessionsProps) {
  const { filters, reset, isDefault } = useFilters();
  const [sort, setSort] = useState<Sort>({ key: 'firstTs', dir: 'desc' });
  const [open, setOpen] = useState<string | null>(null);

  const visible = useMemo(() => applyFilters(events, filters), [events, filters]);
  const rows = useMemo(() => sessions(visible, sessionCosts), [visible, sessionCosts]);

  const bySession = useMemo(() => {
    const map = new Map<string, UsageEvent[]>();
    for (const e of visible) {
      const list = map.get(e.sessionId);
      if (list === undefined) map.set(e.sessionId, [e]);
      else list.push(e);
    }
    return map;
  }, [visible]);

  const mixes = useMemo(() => {
    const map = new Map<string, ReturnType<typeof byModel>>();
    for (const [id, list] of bySession) map.set(id, byModel(list));
    return map;
  }, [bySession]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av === bv) return b.firstTs - a.firstTs;
      return av < bv ? -dir : dir;
    });
  }, [rows, sort]);

  const drifted = useMemo(() => {
    let off = 0;
    let compared = 0;
    for (const row of rows) {
      const d = drift(row);
      if (d === null) continue;
      compared += 1;
      if (Math.abs(d) > DRIFT_LIMIT) off += 1;
    }
    return { off, compared };
  }, [rows]);

  const toggleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  };

  const toggleOpen = (sessionId: string) => {
    setOpen((prev) => (prev === sessionId ? null : sessionId));
  };

  if (sorted.length === 0) {
    const notes = relaxable(filters);
    return (
      <section className="card">
        <div className="card-header">
          <h2>Sessions</h2>
        </div>
        <div style={{ padding: 'var(--sp-5) 0', maxWidth: 520 }}>
          {isDefault || notes.length === 0 ? (
            <p style={{ margin: 0 }} className="secondary">
              No sessions recorded yet. The dashboard fills in as Claude Code writes transcripts.
            </p>
          ) : (
            <>
              <p style={{ margin: '0 0 var(--sp-2)' }}>No session matches the current filters.</p>
              <p style={{ margin: '0 0 var(--sp-4)' }} className="secondary">
                Relax one of these to see rows again: {notes.join('; ')}.
              </p>
              <button
                type="button"
                onClick={reset}
                className="pill pill-accent"
                style={{ cursor: 'pointer', padding: '4px 12px' }}
              >
                Reset filters
              </button>
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="card-header">
        <h2>Sessions</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {plural(sorted.length, 'session')}
          {drifted.compared > 0
            ? ` · ${drifted.off} of ${drifted.compared} priced more than 10% off Claude Code’s own total`
            : ' · no cost-state totals to compare yet'}
        </span>
      </div>

      <div className="table-scroll" style={{ maxHeight: 560 }}>
        <table className="table">
          <thead>
            <tr>
              {COLUMNS.map((col) => {
                const key = col.sort;
                const active = key !== null && sort.key === key;
                return (
                  <th
                    key={col.id}
                    className={col.num ? 'num' : undefined}
                    title={col.hint}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {key === null ? (
                      col.label
                    ) : (
                      <button type="button" onClick={() => toggleSort(key)} style={headButton(col.num)}>
                        <span>{col.label}</span>
                        <span aria-hidden="true" style={{ opacity: active ? 1 : 0.25, fontSize: 9 }}>
                          {active && sort.dir === 'asc' ? '▲' : '▼'}
                        </span>
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const expanded = open === row.sessionId;
              const mix = mixes.get(row.sessionId) ?? [];
              return [
                <tr
                  key={row.sessionId}
                  onClick={() => toggleOpen(row.sessionId)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} session ${row.slug ?? row.sessionId.slice(0, 8)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleOpen(row.sessionId);
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                          width: 12,
                          color: 'var(--text-muted)',
                          fontSize: 9,
                        }}
                      >
                        {expanded ? '▼' : '▶'}
                      </button>
                      <div style={{ minWidth: 0, maxWidth: 172 }}>
                        <div style={clipped} title={row.slug ?? row.sessionId}>
                          {row.slug === null ? (
                            <code className="secondary">{row.sessionId.slice(0, 8)}</code>
                          ) : (
                            row.slug
                          )}
                        </div>
                        <div
                          className="muted"
                          style={{ ...clipped, fontSize: 11 }}
                          title={row.gitBranch ?? undefined}
                        >
                          {row.gitBranch ?? 'no branch'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{row.project}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(row.firstTs)}</td>
                  <td className="num">{formatDuration(row.durationMs)}</td>
                  <td>
                    <ModelMix mix={mix} />
                  </td>
                  <td className="num">{formatCount(row.requests)}</td>
                  <td className="num">{formatCompact(row.totalTokens)}</td>
                  <td className="num">{formatCost(row.cost)}</td>
                  <td className="num">
                    {row.reportedCost === null ? <span className="muted">–</span> : formatCost(row.reportedCost)}
                  </td>
                  <td className="num">
                    <DriftCell value={drift(row)} />
                  </td>
                </tr>,
                expanded ? (
                  <tr key={`${row.sessionId}-detail`}>
                    <td colSpan={COLUMNS.length} style={{ background: 'var(--bg)' }}>
                      <SessionDetail row={row} events={bySession.get(row.sessionId) ?? []} mix={mix} />
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
