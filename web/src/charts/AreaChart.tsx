import { useMemo, useRef, useState } from 'react';
import { formatCompact } from '../lib/format.ts';
import {
  axisTicks,
  clamp,
  linePath,
  linearScale,
  logScale,
  nearestIndex,
  niceDomain,
  truncate,
  useContainerWidth,
  type Pt,
} from './scale.ts';
import { Tooltip, type TooltipRow } from './Tooltip.tsx';

export type ChartPoint = { x: number; y: number };

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  points: readonly ChartPoint[];
};

export type AreaChartProps = {
  series: readonly ChartSeries[];
  height?: number;
  stacked?: boolean;
  yScale?: 'linear' | 'log';
  formatY?: (value: number) => string;
  formatX?: (value: number) => string;
  ariaLabel?: string;
  emptyMessage?: string;
};

const PAD_TOP = 12;
const PAD_RIGHT = 14;
const PAD_BOTTOM = 26;

export function AreaChart({
  series,
  height = 220,
  stacked = false,
  yScale = 'linear',
  formatY = formatCompact,
  formatX = (value) => String(value),
  ariaLabel,
  emptyMessage = 'No data in range',
}: AreaChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(box);
  const [hover, setHover] = useState<{ index: number; py: number } | null>(null);

  const model = useMemo(() => {
    const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
    const columns = series.map((s) => {
      const byX = new Map(s.points.map((p) => [p.x, p.y]));
      return xs.map((x) => {
        const y = byX.get(x);
        return typeof y === 'number' && Number.isFinite(y) ? y : 0;
      });
    });
    return { xs, columns };
  }, [series]);

  const { xs, columns } = model;
  const log = yScale === 'log';
  const stack = stacked && !log;

  if (series.length === 0 || xs.length === 0) {
    return (
      <div
        ref={box}
        role="img"
        aria-label={ariaLabel ?? emptyMessage}
        style={{
          height,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-muted)',
          fontSize: 12,
          border: '1px solid var(--chart-grid)',
          borderRadius: 6,
        }}
      >
        {emptyMessage}
      </div>
    );
  }

  const tops: number[][] = [];
  for (let i = 0; i < columns.length; i += 1) {
    const own = columns[i] ?? [];
    const below = stack ? tops[i - 1] : undefined;
    tops.push(own.map((y, j) => (below === undefined ? y : (below[j] ?? 0) + y)));
  }

  const flat = tops.flat();
  const dataMax = flat.length === 0 ? 0 : Math.max(...flat);
  const dataMin = flat.length === 0 ? 0 : Math.min(...flat);
  const positives = flat.filter((v) => v > 0);
  const yDomain: [number, number] = log
    ? [positives.length === 0 ? 1 : Math.max(1, Math.min(...positives)), Math.max(dataMax, 10)]
    : niceDomain(Math.min(0, dataMin), dataMax);

  const probeScale = log ? logScale(yDomain, [1, 0]) : linearScale(yDomain, [1, 0]);
  const yTicks = axisTicks(probeScale, height < 160 ? 3 : 4, flat.every(Number.isInteger) ? 1 : 0);
  const tickLabels = yTicks.map(formatY);
  const padLeft = clamp(10 + Math.max(...tickLabels.map((t) => t.length)) * 7, 34, 92);

  const plotLeft = padLeft;
  const plotRight = Math.max(plotLeft + 20, width - PAD_RIGHT);
  const plotTop = PAD_TOP;
  const plotBottom = Math.max(plotTop + 20, height - PAD_BOTTOM);

  const first = xs[0] ?? 0;
  const last = xs[xs.length - 1] ?? first;
  const x = linearScale([first, last], [plotLeft, plotRight]);
  const y = log
    ? logScale(yDomain, [plotBottom, plotTop])
    : linearScale(yDomain, [plotBottom, plotTop]);
  const px = xs.map((v) => x.to(v));
  const baseY = y.to(log ? yDomain[0] : Math.max(0, yDomain[0]));

  const xTickCount = clamp(Math.floor((plotRight - plotLeft) / 88), 2, 6);
  const xTickIndexes =
    xs.length <= xTickCount
      ? xs.map((_, i) => i)
      : Array.from({ length: xTickCount }, (_, i) =>
          Math.round((i * (xs.length - 1)) / (xTickCount - 1)),
        );

  const bands = tops.map((top, i) => {
    const below = stack ? tops[i - 1] : undefined;
    const runs: number[][] = [];
    top.forEach((v, j) => {
      const drawable = log ? v > 0 : true;
      if (!drawable) return;
      const open = runs[runs.length - 1];
      if (open !== undefined && (open[open.length - 1] ?? -2) === j - 1) open.push(j);
      else runs.push([j]);
    });
    return runs.map((run) => {
      const upper: Pt[] = run.map((j) => ({ x: px[j] ?? 0, y: y.to(top[j] ?? 0) }));
      const lower: Pt[] = run.map((j) => ({
        x: px[j] ?? 0,
        y: below === undefined ? baseY : y.to(below[j] ?? 0),
      }));
      return {
        line: linePath(upper),
        area: `${linePath(upper)}${linePath([...lower].reverse()).replace('M', 'L')}Z`,
        single: run.length === 1,
        at: run[0] ?? 0,
      };
    });
  });

  const hoverIndex = hover === null ? null : clamp(hover.index, 0, xs.length - 1);
  const rows: TooltipRow[] =
    hoverIndex === null
      ? []
      : [...series]
          .map((s, i) => ({
            label: s.label,
            value: formatY(columns[i]?.[hoverIndex] ?? 0),
            color: s.color,
          }))
          .reverse();
  if (hoverIndex !== null && stack && series.length > 1) {
    const total = columns.reduce((sum, column) => sum + (column[hoverIndex] ?? 0), 0);
    rows.push({ label: 'Total', value: formatY(total), strong: true });
  }

  const summary =
    ariaLabel ??
    `Area chart, ${series.length} series (${series.map((s) => s.label).join(', ')}), ${xs.length} point${xs.length === 1 ? '' : 's'} from ${formatX(first)} to ${formatX(last)}, ${formatY(dataMin)} to ${formatY(dataMax)}${log ? ', logarithmic scale' : ''}${stack ? ', stacked' : ''}`;

  return (
    <div ref={box} style={{ position: 'relative', width: '100%' }}>
      {series.length > 1 ? (
        <ul
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 14px',
            listStyle: 'none',
            margin: '0 0 6px',
            padding: 0,
            fontSize: 11,
            color: 'var(--text-secondary)',
          }}
        >
          {series
            .map((s, index) => ({ s, index }))
            .reverse()
            .map(({ s, index }) => {
              const latest = columns[index]?.[xs.length - 1] ?? 0;
              return (
                <li key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: s.color,
                      flex: '0 0 auto',
                    }}
                  />
                  <span>{s.label}</span>
                  <span
                    style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatY(latest)}
                  </span>
                </li>
              );
            })}
        </ul>
      ) : null}

      <svg
        width={width}
        height={height}
        role="img"
        aria-label={summary}
        tabIndex={0}
        style={{ display: 'block', touchAction: 'none', outlineOffset: 2 }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover({
            index: nearestIndex(px, e.clientX - rect.left),
            py: clamp(e.clientY - rect.top, plotTop, plotBottom),
          });
        }}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover({ index: xs.length - 1, py: (plotTop + plotBottom) / 2 })}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const current = hover?.index ?? xs.length - 1;
          setHover({
            index: clamp(current + (e.key === 'ArrowRight' ? 1 : -1), 0, xs.length - 1),
            py: hover?.py ?? (plotTop + plotBottom) / 2,
          });
        }}
      >
        {yTicks.map((tick, i) => {
          const ty = y.to(tick);
          return (
            <g key={tick}>
              <line
                x1={plotLeft}
                x2={plotRight}
                y1={ty}
                y2={ty}
                stroke="var(--chart-grid)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={plotLeft - 8}
                y={ty + 4}
                textAnchor="end"
                fill="var(--text-muted)"
                fontSize={11}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {tickLabels[i]}
              </text>
            </g>
          );
        })}

        <line
          x1={plotLeft}
          x2={plotRight}
          y1={plotBottom}
          y2={plotBottom}
          stroke="var(--chart-axis)"
          strokeWidth={1}
          shapeRendering="crispEdges"
        />

        {xTickIndexes.map((index) => (
          <text
            key={index}
            x={clamp(px[index] ?? 0, plotLeft + 12, plotRight - 12)}
            y={plotBottom + 16}
            textAnchor="middle"
            fill="var(--text-muted)"
            fontSize={11}
          >
            {truncate(formatX(xs[index] ?? 0), 96)}
          </text>
        ))}

        {bands.map((runs, i) => {
          const s = series[i];
          if (s === undefined) return null;
          return runs.map((band, r) => (
            <path
              key={`${s.key}-fill-${r}`}
              d={band.area}
              fill={s.color}
              fillOpacity={stack ? 0.85 : 0.12}
              stroke={stack ? 'var(--surface-1)' : 'none'}
              strokeWidth={stack ? 2 : 0}
            />
          ));
        })}

        {bands.map((runs, i) => {
          const s = series[i];
          if (s === undefined) return null;
          return runs.map((band, r) => {
            if (band.single) {
              return (
                <circle
                  key={`${s.key}-dot-${r}`}
                  cx={px[band.at] ?? 0}
                  cy={y.to(tops[i]?.[band.at] ?? 0)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              );
            }
            return stack ? null : (
              <path
                key={`${s.key}-line-${r}`}
                d={band.line}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          });
        })}

        {hoverIndex === null ? null : (
          <g pointerEvents="none">
            <line
              x1={px[hoverIndex] ?? 0}
              x2={px[hoverIndex] ?? 0}
              y1={plotTop}
              y2={plotBottom}
              stroke="var(--chart-axis)"
              strokeWidth={1}
            />
            {tops.map((top, i) => {
              const s = series[i];
              if (s === undefined) return null;
              if (log && (top[hoverIndex] ?? 0) <= 0) return null;
              return (
                <circle
                  key={`${s.key}-hover`}
                  cx={px[hoverIndex] ?? 0}
                  cy={y.to(top[hoverIndex] ?? 0)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              );
            })}
          </g>
        )}
      </svg>

      {hoverIndex === null ? null : (
        <Tooltip
          x={px[hoverIndex] ?? 0}
          y={hover?.py ?? plotTop}
          containerWidth={width}
          title={formatX(xs[hoverIndex] ?? 0)}
          rows={rows}
        />
      )}
    </div>
  );
}
