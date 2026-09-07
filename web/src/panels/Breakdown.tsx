import { useMemo, useState } from 'react';
import { EFFORTS } from '../../../shared/types.ts';
import type { UsageEvent } from '../../../shared/types.ts';
import { AreaChart, BarChart } from '../charts/index.ts';
import type { BarDatum, ChartPoint, ChartSeries } from '../charts/index.ts';
import {
  colorForEffort,
  colorForModel,
  effortLabel,
  formatCompact,
  formatCost,
  formatCostCompact,
  formatCount,
  formatDayLabel,
  formatPercent,
  modelLabel,
} from '../lib/format.ts';
import {
  byBranch,
  byDay,
  byEffort,
  byModel,
  byProject,
  distinctModels,
  distinctProjects,
  groupBy,
  totals,
} from '../lib/select.ts';
import type { Totals } from '../lib/select.ts';

export type BreakdownProps = {
  events: readonly UsageEvent[];
  loading?: boolean;
};

type MetricId = 'tokens' | 'cost' | 'requests';

type Metric = {
  id: MetricId;
  label: string;
  field: keyof Totals;
  format: (n: number) => string;
  formatTotal: (n: number) => string;
};

const METRICS: Record<MetricId, Metric> = {
  tokens: {
    id: 'tokens',
    label: 'Tokens',
    field: 'totalTokens',
    format: formatCompact,
    formatTotal: formatCompact,
  },
  cost: {
    id: 'cost',
    label: 'Cost',
    field: 'cost',
    format: formatCostCompact,
    formatTotal: formatCost,
  },
  requests: {
    id: 'requests',
    label: 'Requests',
    field: 'requests',
    format: formatCount,
    formatTotal: formatCount,
  },
};

const METRIC_ORDER: readonly MetricId[] = ['tokens', 'cost', 'requests'];

const OTHER = '__other__';

const MIX_SERIES_TOP = 5;
const MODEL_BAR_TOP = 8;
const PROJECT_TOP = 12;
const BRANCH_TOP = 6;
const AGENT_TOP = 7;

const NOMINAL = 'var(--series-1)';
const SUB_HUE = 'var(--series-2)';
const TAIL_HUE = 'var(--series-other)';

type Described = { label: string; color: string };

/**
 * `groupBy` always ranks and shares by token volume, so a cost or request view has
 * to be re-ranked here off the chosen field. The collapsed tail is pinned last
 * whatever the metric, so "Other" never outranks a real row.
 */
function bars<K>(
  rows: ReadonlyArray<{ key: K | typeof OTHER } & Totals>,
  metric: Metric,
  describe: (key: K | typeof OTHER) => Described,
): BarDatum[] {
  return rows
    .map((row) => ({ row, tail: row.key === OTHER, ...describe(row.key) }))
    .sort((a, b) => Number(a.tail) - Number(b.tail) || b.row[metric.field] - a.row[metric.field])
    .map(({ row, label, color }) => ({
      key: String(row.key),
      label,
      value: row[metric.field],
      color,
    }));
}

function sum(rows: readonly BarDatum[]): number {
  let out = 0;
  for (const row of rows) out += row.value;
  return out;
}

function tail(count: number, top: number, noun: string): string {
  const rest = Math.max(count - top, 0);
  return `Other (${formatCount(rest)} ${noun}${rest === 1 ? '' : 's'})`;
}

function MetricSwitch({
  value,
  onChange,
}: {
  value: MetricId;
  onChange: (next: MetricId) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Metric"
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden',
        background: 'var(--surface)',
      }}
    >
      {METRIC_ORDER.map((id, index) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(id)}
            style={{
              border: 'none',
              borderLeft: index === 0 ? 'none' : '1px solid var(--border)',
              padding: '5px 14px',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              background: active ? 'var(--accent-soft)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-secondary)',
            }}
          >
            {METRICS[id].label}
          </button>
        );
      })}
    </div>
  );
}

function CardHead({
  title,
  total,
  note,
}: {
  title: string;
  total: string;
  note?: string;
}) {
  return (
    <div className="card-header">
      <div>
        <h2>{title}</h2>
        {note === undefined ? null : (
          <div className="muted" style={{ fontSize: 11 }}>
            {note}
          </div>
        )}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {total}
      </div>
    </div>
  );
}

function Meter({ fill, color }: { fill: number; color: string }) {
  const pct = Number.isFinite(fill) ? Math.max(0, Math.min(1, fill)) : 0;
  return (
    <div
      aria-hidden="true"
      style={{
        height: 6,
        borderRadius: 3,
        background: 'var(--chart-grid)',
        overflow: 'hidden',
        minWidth: 40,
      }}
    >
      <div style={{ width: `${pct * 100}%`, height: '100%', borderRadius: 3, background: color }} />
    </div>
  );
}

function ProjectTable({
  events,
  metric,
}: {
  events: readonly UsageEvent[];
  metric: Metric;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const ranked = useMemo(() => {
    const rows = bars(byProject(events, { top: PROJECT_TOP }), metric, (key) =>
      key === OTHER
        ? { label: tail(distinctProjects(events).length, PROJECT_TOP, 'project'), color: TAIL_HUE }
        : { label: key, color: NOMINAL },
    );
    let peak = 0;
    for (const row of rows) peak = Math.max(peak, row.value);
    return { rows, total: sum(rows), peak };
  }, [events, metric]);

  const branches = useMemo(() => {
    if (open === null) return [];
    const scoped = events.filter((event) => event.project === open);
    return bars(byBranch(scoped, { top: BRANCH_TOP }), metric, (key) =>
      key === OTHER
        ? { label: 'Other branches', color: TAIL_HUE }
        : { label: key ?? 'No branch', color: NOMINAL },
    );
  }, [events, metric, open]);

  if (ranked.rows.length === 0) {
    return <div className="muted">No projects in range</div>;
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Project</th>
            <th style={{ width: '32%' }}>Relative to top</th>
            <th className="num">{metric.label}</th>
            <th className="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {ranked.rows.map((row) => {
            const share = ranked.total > 0 ? row.value / ranked.total : 0;
            const expandable = row.key !== OTHER;
            const expanded = open === row.key;
            return [
              <tr key={row.key}>
                <td>
                  {expandable ? (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : row.key)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        border: 'none',
                        background: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: 'var(--text)',
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className="muted"
                        style={{
                          fontSize: 9,
                          width: 8,
                          display: 'inline-block',
                          transform: expanded ? 'rotate(90deg)' : 'none',
                        }}
                      >
                        ▶
                      </span>
                      {row.label}
                    </button>
                  ) : (
                    <span className="muted" style={{ paddingLeft: 14 }}>
                      {row.label}
                    </span>
                  )}
                </td>
                <td>
                  <Meter
                    fill={ranked.peak > 0 ? row.value / ranked.peak : 0}
                    color={row.color ?? NOMINAL}
                  />
                </td>
                <td className="num">{metric.format(row.value)}</td>
                <td className="num muted">{formatPercent(share, share < 0.1 ? 1 : 0)}</td>
              </tr>,
              expanded ? (
                <tr key={`${row.key}-branches`}>
                  <td colSpan={4} style={{ background: 'var(--surface-hover)' }}>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                      {`Branches in ${row.label}`}
                    </div>
                    <BarChart
                      data={branches}
                      formatValue={metric.format}
                      rowHeight={24}
                      ariaLabel={`Branch split for ${row.label} by ${metric.label.toLowerCase()}`}
                      emptyMessage="No git branch recorded for these requests"
                    />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function SubagentCard({ events, metric }: { events: readonly UsageEvent[]; metric: Metric }) {
  const split = useMemo(() => {
    const main = totals(events.filter((event) => !event.isSidechain));
    const sub = totals(events.filter((event) => event.isSidechain));
    const rows = bars(
      groupBy(
        events.filter((event) => event.isSidechain),
        (event) => event.attributionAgent ?? 'Untagged',
        { top: AGENT_TOP },
      ),
      metric,
      (key) => (key === OTHER ? { label: 'Other agents', color: TAIL_HUE } : { label: key, color: SUB_HUE }),
    );
    const mainValue = main[metric.field];
    const subValue = sub[metric.field];
    const whole = mainValue + subValue;
    return { mainValue, subValue, rows, subShare: whole > 0 ? subValue / whole : 0, whole };
  }, [events, metric]);

  return (
    <div className="card">
      <CardHead
        title="Main thread vs subagents"
        total={metric.formatTotal(split.whole)}
        note={`Subagents are ${formatPercent(split.subShare, 1)} of ${metric.label.toLowerCase()}`}
      />

      <div className="grid-tiles" style={{ marginBottom: 'var(--sp-3)' }}>
        <div className="tile">
          <span className="tile-label">
            <span className="swatch" style={{ background: NOMINAL, marginRight: 6 }} />
            Main thread
          </span>
          <span className="tile-value">{metric.format(split.mainValue)}</span>
          <span className="tile-delta">{formatPercent(1 - split.subShare, 1)} of total</span>
        </div>
        <div className="tile">
          <span className="tile-label">
            <span className="swatch" style={{ background: SUB_HUE, marginRight: 6 }} />
            Subagents
          </span>
          <span className="tile-value">{metric.format(split.subValue)}</span>
          <span className="tile-delta">{formatPercent(split.subShare, 1)} of total</span>
        </div>
      </div>

      <div
        role="img"
        aria-label={`Main thread ${metric.format(split.mainValue)}, subagents ${metric.format(split.subValue)}`}
        style={{ display: 'flex', gap: 2, height: 10, marginBottom: 'var(--sp-5)' }}
      >
        {split.whole > 0 ? (
          <>
            <div
              style={{
                flexGrow: split.mainValue,
                background: NOMINAL,
                borderRadius: '3px 0 0 3px',
                minWidth: split.mainValue > 0 ? 2 : 0,
              }}
            />
            <div
              style={{
                flexGrow: split.subValue,
                background: SUB_HUE,
                borderRadius: '0 3px 3px 0',
                minWidth: split.subValue > 0 ? 2 : 0,
              }}
            />
          </>
        ) : (
          <div style={{ flexGrow: 1, background: 'var(--chart-grid)', borderRadius: 3 }} />
        )}
      </div>

      <h3 style={{ marginBottom: 'var(--sp-2)' }}>{`Subagent types by ${metric.label.toLowerCase()}`}</h3>
      <BarChart
        data={split.rows}
        formatValue={metric.format}
        ariaLabel={`Subagent types ranked by ${metric.label.toLowerCase()}`}
        emptyMessage="No subagent requests in range"
      />
    </div>
  );
}

function ModelMix({ events, metric }: { events: readonly UsageEvent[]; metric: Metric }) {
  const series = useMemo<ChartSeries[]>(() => {
    const ranked = distinctModels(events);
    const head = ranked.slice(0, MIX_SERIES_TOP);
    const rest = new Set(ranked.slice(MIX_SERIES_TOP));

    const whole = byDay(events).filter((day) => day[metric.field] > 0);
    const denominator = new Map(whole.map((day) => [day.day, day[metric.field]]));
    const axis = new Map(whole.map((day) => [day.day, day.ts]));

    const build = (scoped: UsageEvent[]): ChartPoint[] => {
      const points: ChartPoint[] = [];
      for (const day of byDay(scoped)) {
        const total = denominator.get(day.day);
        const x = axis.get(day.day);
        if (total === undefined || x === undefined) continue;
        // Floored so a stacked column can never sum past 1. A float sum of 1+1e-16
        // makes niceDomain ceil the axis to 120%, which reads as a data error.
        points.push({ x, y: Math.floor((day[metric.field] / total) * 1e9) / 1e9 });
      }
      return points;
    };

    const out: ChartSeries[] = head.map((model) => ({
      key: model,
      label: modelLabel(model),
      color: colorForModel(model),
      points: build(events.filter((event) => event.model === model)),
    }));
    if (rest.size > 0) {
      out.push({
        key: OTHER,
        label: `Other (${formatCount(rest.size)} models)`,
        color: TAIL_HUE,
        points: build(events.filter((event) => rest.has(event.model))),
      });
    }
    return out.filter((entry) => entry.points.length > 0);
  }, [events, metric]);

  return (
    <div className="card">
      <CardHead
        title="Model mix over time"
        total={`${formatCount(series.length)} models`}
        note={`Share of daily ${metric.label.toLowerCase()}. Days with no requests are omitted.`}
      />
      <AreaChart
        series={series}
        stacked
        height={240}
        formatY={(value) => formatPercent(value, 0)}
        formatX={formatDayLabel}
        ariaLabel={`Stacked share of daily ${metric.label.toLowerCase()} by model`}
        emptyMessage="No requests in range"
      />
    </div>
  );
}

export function Breakdown({ events, loading = false }: BreakdownProps) {
  const [metricId, setMetricId] = useState<MetricId>('tokens');
  const metric = METRICS[metricId];

  const grand = useMemo(() => totals(events), [events]);

  const modelRows = useMemo(
    () =>
      bars(byModel(events, { top: MODEL_BAR_TOP }), metric, (key) =>
        key === OTHER
          ? { label: tail(distinctModels(events).length, MODEL_BAR_TOP, 'model'), color: TAIL_HUE }
          : { label: modelLabel(key), color: colorForModel(key) },
      ),
    [events, metric],
  );

  const effort = useMemo(() => {
    const rows = byEffort(events);
    const indexed = new Map(rows.map((row) => [row.key, row]));
    const out: BarDatum[] = [];
    for (const level of EFFORTS) {
      const row = indexed.get(level);
      if (row === undefined) continue;
      out.push({
        key: level,
        label: effortLabel(level),
        value: row[metric.field],
        color: colorForEffort(level),
      });
    }
    const tagged = rows.reduce((into, row) => into + row.requests, 0);
    return { rows: out, total: sum(out), untagged: events.length - tagged };
  }, [events, metric]);

  const projectCount = useMemo(() => distinctProjects(events).length, [events]);

  if (events.length === 0) {
    return (
      <section>
        <div className="card" style={{ display: 'grid', placeItems: 'center', minHeight: 220 }}>
          <div style={{ textAlign: 'center', maxWidth: 380 }}>
            <h2>{loading ? 'Reading 30 days of transcripts' : 'Nothing to break down'}</h2>
            <p className="secondary">
              {loading
                ? 'Backfill is still running. Breakdowns appear as soon as the first requests land.'
                : 'No request in the current filter range. Widen the date range, or clear the project, model and agent filters.'}
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--sp-4)',
          flexWrap: 'wrap',
          marginBottom: 'var(--sp-4)',
        }}
      >
        <div>
          <h1>Where it went</h1>
          <div className="muted" style={{ fontSize: 12 }}>
            {`${formatCount(events.length)} requests across ${formatCount(projectCount)} projects`}
          </div>
        </div>
        <MetricSwitch value={metricId} onChange={setMetricId} />
      </div>

      {/*
        The two half-width cards get their own auto-fit grid. A `.span-full` sibling
        keeps every track occupied, so the empty tracks stop collapsing and these two
        shrink to one column's width instead of splitting the row.
      */}
      <div className="grid" style={{ marginBottom: 'var(--sp-4)' }}>
        <div className="card">
          <CardHead title="By model" total={metric.formatTotal(grand[metric.field])} />
          <BarChart
            data={modelRows}
            formatValue={metric.format}
            ariaLabel={`Models ranked by ${metric.label.toLowerCase()}`}
            emptyMessage="No requests in range"
          />
        </div>

        <div className="card">
          <CardHead
            title="By effort"
            total={metric.formatTotal(effort.total)}
            note={
              effort.untagged > 0
                ? `${formatCount(effort.untagged)} requests carry no effort level and are excluded`
                : undefined
            }
          />
          <BarChart
            data={effort.rows}
            formatValue={metric.format}
            ariaLabel={`Effort levels by ${metric.label.toLowerCase()}, low to max`}
            emptyMessage="No request in range carries an effort level"
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div className="card">
          <CardHead
            title="By project"
            total={metric.formatTotal(grand[metric.field])}
            note="Expand a project to see its git branch split"
          />
          <ProjectTable events={events} metric={metric} />
        </div>

        <ModelMix events={events} metric={metric} />
        <SubagentCard events={events} metric={metric} />
      </div>
    </section>
  );
}
