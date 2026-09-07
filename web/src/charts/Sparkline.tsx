import { useRef } from 'react';
import { formatCompact } from '../lib/format.ts';
import { linePath, linearScale, useContainerWidth, type Pt } from './scale.ts';

export type SparklineProps = {
  values: readonly number[];
  color?: string;
  height?: number;
  formatValue?: (value: number) => string;
  ariaLabel?: string;
};

export function Sparkline({
  values,
  color = 'var(--series-1)',
  height = 30,
  formatValue = formatCompact,
  ariaLabel,
}: SparklineProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(box, 120);

  const clean = values.filter((v) => Number.isFinite(v));
  const min = clean.length === 0 ? 0 : Math.min(...clean);
  const max = clean.length === 0 ? 0 : Math.max(...clean);
  const latest = clean[clean.length - 1] ?? 0;

  const right = Math.max(4, width - 3);
  const x =
    clean.length === 1
      ? linearScale([-1, 1], [2, right])
      : linearScale([0, clean.length - 1], [2, right]);
  const y = linearScale([min, max], [height - 3, 3]);
  const points: Pt[] = clean.map((v, i) => ({ x: x.to(i), y: y.to(v) }));
  const lastPoint = points[points.length - 1];

  const summary =
    ariaLabel ??
    (clean.length === 0
      ? 'Sparkline, no data'
      : `Sparkline, ${clean.length} point${clean.length === 1 ? '' : 's'}, latest ${formatValue(latest)}, range ${formatValue(min)} to ${formatValue(max)}`);

  return (
    <div ref={box} style={{ width: '100%', lineHeight: 0 }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={summary}
        style={{ display: 'block' }}
      >
        {points.length === 0 ? (
          <line
            x1={2}
            x2={Math.max(4, width - 3)}
            y1={height - 3}
            y2={height - 3}
            stroke="var(--chart-grid)"
            strokeWidth={1}
          />
        ) : null}
        {points.length > 1 ? (
          <>
            <path
              d={`${linePath(points)}L${(lastPoint?.x ?? 0).toFixed(2)} ${height}L${(points[0]?.x ?? 0).toFixed(2)} ${height}Z`}
              fill={color}
              fillOpacity={0.12}
            />
            <path
              d={linePath(points)}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : null}
        {lastPoint === undefined ? null : (
          <circle
            cx={lastPoint.x}
            cy={lastPoint.y}
            r={3}
            fill={color}
            stroke="var(--surface-1)"
            strokeWidth={2}
          />
        )}
      </svg>
    </div>
  );
}
