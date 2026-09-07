import { useMemo } from 'react';
import type { UsageEvent } from '../../../shared/types.ts';
import { AreaChart, BarChart } from '../charts/index.ts';
import type { BarDatum, ChartPoint } from '../charts/index.ts';
import {
  colorForTokenKind,
  formatCompact,
  formatCost,
  formatCount,
  formatDayLabel,
  formatPercent,
} from '../lib/format.ts';
import { byDay, cacheStats, totals } from '../lib/select.ts';

export type CacheProps = {
  events: readonly UsageEvent[];
  loading?: boolean;
};

/**
 * The published cache multipliers against a model's plain input rate. Multiplying a
 * token count by its multiplier gives an input-rate-equivalent volume, which compares
 * the two write TTLs as spend without needing a dollar rate table in the browser.
 */
const WRITE_5M_MULTIPLIER = 1.25;
const WRITE_1H_MULTIPLIER = 2;

const FRESH_HUE = colorForTokenKind('input');
const READ_HUE = colorForTokenKind('cacheRead');
const TTL_5M_HUE = colorForTokenKind('cacheWrite5m');
const TTL_1H_HUE = colorForTokenKind('cacheWrite1h');
const BILLED_HUE = 'var(--series-1)';
const SAVED_HUE = 'var(--series-3)';

const NOTE_STYLE = { fontSize: 11, margin: 'var(--sp-3) 0 0' } as const;

function Lead({ value, caption }: { value: string; caption: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 40,
          lineHeight: 1.1,
          fontWeight: 600,
          letterSpacing: '-0.02em',
        }}
      >
        {value}
      </div>
      <div className="secondary" style={{ fontSize: 12 }}>
        {caption}
      </div>
    </div>
  );
}

function SplitBar({
  left,
  right,
  leftColor,
  rightColor,
  label,
}: {
  left: number;
  right: number;
  leftColor: string;
  rightColor: string;
  label: string;
}) {
  const whole = left + right;
  return (
    <div role="img" aria-label={label} style={{ display: 'flex', gap: 2, height: 10 }}>
      {whole > 0 ? (
        <>
          <div
            style={{
              flexGrow: left,
              background: leftColor,
              borderRadius: '3px 0 0 3px',
              minWidth: left > 0 ? 2 : 0,
            }}
          />
          <div
            style={{
              flexGrow: right,
              background: rightColor,
              borderRadius: '0 3px 3px 0',
              minWidth: right > 0 ? 2 : 0,
            }}
          />
        </>
      ) : (
        <div style={{ flexGrow: 1, background: 'var(--chart-grid)', borderRadius: 3 }} />
      )}
    </div>
  );
}

function Key({ items }: { items: ReadonlyArray<{ color: string; label: string; value: string }> }) {
  return (
    <ul
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 16px',
        listStyle: 'none',
        margin: 'var(--sp-2) 0 0',
        padding: 0,
        fontSize: 11,
        color: 'var(--text-secondary)',
      }}
    >
      {items.map((item) => (
        <li key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span className="swatch" style={{ background: item.color }} />
          <span>{item.label}</span>
          <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
            {item.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Cache({ events, loading = false }: CacheProps) {
  const stats = useMemo(() => cacheStats(events), [events]);
  const volume = useMemo(() => totals(events), [events]);

  const composition = useMemo<BarDatum[]>(
    () =>
      [
        { key: 'freshInput', label: 'Fresh input', value: stats.freshInput, color: FRESH_HUE },
        { key: 'cacheRead', label: 'Cache read', value: stats.cacheRead, color: READ_HUE },
        { key: 'cacheWrite', label: 'Cache write', value: stats.cacheWrite, color: TTL_5M_HUE },
      ].sort((a, b) => b.value - a.value),
    [stats],
  );

  const ttl = useMemo(() => {
    const weight5m = volume.cacheWrite5m * WRITE_5M_MULTIPLIER;
    const weight1h = volume.cacheWrite1h * WRITE_1H_MULTIPLIER;
    const weight = weight5m + weight1h;
    return {
      spend5m: weight > 0 ? weight5m / weight : 0,
      spend1h: weight > 0 ? weight1h / weight : 0,
    };
  }, [volume]);

  const trend = useMemo(() => {
    const points: ChartPoint[] = [];
    let low = Infinity;
    let high = -Infinity;
    for (const day of byDay(events)) {
      const inputSide = day.input + day.cacheRead + day.cacheWrite;
      if (inputSide <= 0) continue;
      const ratio = day.cacheRead / inputSide;
      points.push({ x: day.ts, y: ratio });
      low = Math.min(low, ratio);
      high = Math.max(high, ratio);
    }
    return { points, low, high };
  }, [events]);

  if (events.length === 0) {
    return (
      <section>
        <div className="card" style={{ display: 'grid', placeItems: 'center', minHeight: 220 }}>
          <div style={{ textAlign: 'center', maxWidth: 380 }}>
            <h2>{loading ? 'Reading 30 days of transcripts' : 'No cache activity to read'}</h2>
            <p className="secondary">
              {loading
                ? 'Backfill is still running. Cache economics appear as soon as the first requests land.'
                : 'No request in the current filter range. Widen the date range, or clear the project, model and agent filters.'}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const inputSide = volume.input + volume.cacheRead + volume.cacheWrite;
  const paidShare = volume.uncachedCost > 0 ? volume.cost / volume.uncachedCost : 0;

  return (
    <section>
      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <h1>Cache economics</h1>
        <div className="muted" style={{ fontSize: 12 }}>
          {`${formatCount(events.length)} requests, ${formatCompact(inputSide)} input-side tokens`}
        </div>
      </div>

      {/*
        The full-width cards stay outside this grid: a `.span-full` sibling keeps every
        auto-fit track occupied, so the empty tracks stop collapsing and these two
        shrink to one column's width instead of splitting the row.
      */}
      <div className="grid" style={{ marginBottom: 'var(--sp-4)' }}>
        <div className="card">
          <div className="card-header">
            <h2>Hit ratio</h2>
          </div>
          <Lead
            value={formatPercent(stats.hitRatio, 1)}
            caption="of input-side tokens were served from cache"
          />
          <div style={{ marginTop: 'var(--sp-5)' }}>
            <BarChart
              data={composition}
              formatValue={formatCompact}
              showShare={false}
              ariaLabel="Input-side tokens split into fresh input, cache read and cache write"
              emptyMessage="No input-side tokens in range"
            />
          </div>
          <p className="muted" style={NOTE_STYLE}>
            Fresh input is what the model had to read at full price. A cache read bills at 0.1x
            that rate and a write above it, so these three rows are volumes, not money.
          </p>
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <h2>Ephemeral write TTL</h2>
              <div className="muted" style={{ fontSize: 11 }}>
                Which cache lifetime the write spend went to
              </div>
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {formatCompact(stats.cacheWrite)}
            </div>
          </div>

          <SplitBar
            left={volume.cacheWrite5m}
            right={volume.cacheWrite1h}
            leftColor={TTL_5M_HUE}
            rightColor={TTL_1H_HUE}
            label={`5-minute writes ${formatCompact(volume.cacheWrite5m)} tokens, 1-hour writes ${formatCompact(volume.cacheWrite1h)} tokens`}
          />

          <div className="table-scroll" style={{ marginTop: 'var(--sp-4)' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>TTL</th>
                  <th className="num">Tokens</th>
                  <th className="num">Writes</th>
                  <th className="num">Spend</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className="swatch" style={{ background: TTL_5M_HUE, marginRight: 6 }} />
                    5 minutes
                    <span className="muted"> 1.25x</span>
                  </td>
                  <td className="num">{formatCompact(volume.cacheWrite5m)}</td>
                  <td className="num">{formatPercent(stats.split5m, 1)}</td>
                  <td className="num">{formatPercent(ttl.spend5m, 1)}</td>
                </tr>
                <tr>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className="swatch" style={{ background: TTL_1H_HUE, marginRight: 6 }} />
                    1 hour
                    <span className="muted"> 2x</span>
                  </td>
                  <td className="num">{formatCompact(volume.cacheWrite1h)}</td>
                  <td className="num">{formatPercent(stats.split1h, 1)}</td>
                  <td className="num">{formatPercent(ttl.spend1h, 1)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="muted" style={NOTE_STYLE}>
            Spend share weights each token count by its multiplier against the plain input rate,
            so it holds for every model without a rate table. A 1-hour write costs 2x input
            against 1.25x for 5 minutes, so it pays for itself the moment a prefix survives into
            a second 5-minute window, where re-writing would have cost 2.5x.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div className="card">
          <div className="card-header">
            <div>
              <h2>Estimated savings</h2>
              <div className="muted" style={{ fontSize: 11 }}>
                Billed cost against the same traffic with caching switched off
              </div>
            </div>
            <span className="pill pill-accent">{formatPercent(stats.savingsRatio, 1)} saved</span>
          </div>

          <div className="grid-tiles" style={{ marginBottom: 'var(--sp-4)' }}>
            <div className="tile">
              <span className="tile-label">Saved</span>
              <span className="tile-value">{formatCost(stats.savingsUSD)}</span>
              <span className="tile-delta">
                {formatPercent(stats.savingsRatio, 1)} of the uncached estimate
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Billed</span>
              <span className="tile-value">{formatCost(volume.cost)}</span>
              <span className="tile-delta">{formatPercent(paidShare, 1)} of the uncached estimate</span>
            </div>
            <div className="tile">
              <span className="tile-label">Uncached estimate</span>
              <span className="tile-value">{formatCost(volume.uncachedCost)}</span>
              <span className="tile-delta">every read and write repriced as fresh input</span>
            </div>
          </div>

          <SplitBar
            left={volume.cost}
            right={Math.max(stats.savingsUSD, 0)}
            leftColor={BILLED_HUE}
            rightColor={SAVED_HUE}
            label={`Billed ${formatCost(volume.cost)}, saved ${formatCost(stats.savingsUSD)}`}
          />
          <Key
            items={[
              { color: BILLED_HUE, label: 'Billed', value: formatCost(volume.cost) },
              { color: SAVED_HUE, label: 'Saved', value: formatCost(stats.savingsUSD) },
            ]}
          />

          <p className="muted" style={NOTE_STYLE}>
            An estimate, not a measurement. The billed figure comes from the server's pricing
            table. The uncached figure is derived in the browser by repricing cache reads and
            writes at each model's plain input rate, using a local rate map in select.ts rather
            than the server's table, and it assumes the standard multipliers of 0.1x for a read
            against 1.25x and 2x for the two write TTLs. A model missing from that map
            contributes no savings, so the number understates rather than inflates.
          </p>
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <h2>Hit ratio over time</h2>
              <div className="muted" style={{ fontSize: 11 }}>
                {trend.points.length === 0
                  ? "Cache read as a share of that day's input-side tokens"
                  : `Cache read as a share of that day's input-side tokens. ${formatCount(trend.points.length)} active day${trend.points.length === 1 ? '' : 's'}, ${formatPercent(trend.low, 1)} low to ${formatPercent(trend.high, 1)} high.`}
              </div>
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {formatPercent(stats.hitRatio, 1)}
            </div>
          </div>
          <AreaChart
            series={[
              { key: 'hitRatio', label: 'Hit ratio', color: 'var(--accent)', points: trend.points },
            ]}
            height={220}
            formatY={(value) => formatPercent(value, 0)}
            formatX={formatDayLabel}
            ariaLabel="Cache hit ratio per day, share of input-side tokens served from cache"
            emptyMessage="No input-side tokens in range"
          />
        </div>
      </div>
    </section>
  );
}
