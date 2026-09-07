import { useRef, useState } from 'react';
import { formatCompact } from '../lib/format.ts';
import { clamp, truncate, useContainerWidth } from './scale.ts';
import { Tooltip } from './Tooltip.tsx';

export type BarDatum = { key: string; label: string; value: number; color?: string };

export type BarChartProps = {
  data: readonly BarDatum[];
  formatValue?: (value: number) => string;
  /** Share denominator. Defaults to the sum of `data`, so shares read as part-of-whole. */
  total?: number;
  color?: string;
  rowHeight?: number;
  showShare?: boolean;
  ariaLabel?: string;
  emptyMessage?: string;
};

function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w, h / 2);
  if (w <= r) return `M${x} ${y}h${w}v${h}h${-w}z`;
  return `M${x} ${y}h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - r)}z`;
}

export function BarChart({
  data,
  formatValue = formatCompact,
  total,
  color = 'var(--series-1)',
  rowHeight = 28,
  showShare = true,
  ariaLabel,
  emptyMessage = 'No data in range',
}: BarChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(box);
  const [hover, setHover] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div
        ref={box}
        role="img"
        aria-label={ariaLabel ?? emptyMessage}
        style={{
          height: rowHeight * 3,
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

  const values = data.map((d) => (Number.isFinite(d.value) ? Math.max(0, d.value) : 0));
  const max = Math.max(...values);
  const sum = total !== undefined && total > 0 ? total : values.reduce((a, b) => a + b, 0);

  const height = data.length * rowHeight + 2;
  const barH = clamp(rowHeight - 12, 8, 16);
  const shareW = showShare && width >= 340 ? 46 : 0;
  const valueW = 68;
  const labelW = clamp(width * 0.3, 76, 200);
  const trackX = labelW + 10;
  const trackEnd = Math.max(trackX + 24, width - valueW - shareW - 8);
  const trackW = trackEnd - trackX;

  const summary =
    ariaLabel ??
    `Ranked bar chart, ${data.length} row${data.length === 1 ? '' : 's'}, top ${data[0]?.label ?? ''} at ${formatValue(values[0] ?? 0)}, values ${formatValue(Math.min(...values))} to ${formatValue(max)}`;

  return (
    <div ref={box} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={summary}
        tabIndex={0}
        style={{ display: 'block', touchAction: 'none', outlineOffset: 2 }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover(clamp(Math.floor((e.clientY - rect.top - 1) / rowHeight), 0, data.length - 1));
          setHoverX(e.clientX - rect.left);
        }}
        onPointerLeave={() => {
          setHover(null);
          setHoverX(null);
        }}
        onBlur={() => setHover(null)}
        onFocus={() => setHover(0)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          setHover(clamp((hover ?? 0) + (e.key === 'ArrowDown' ? 1 : -1), 0, data.length - 1));
        }}
      >
        {data.map((d, i) => {
          const value = values[i] ?? 0;
          const rowY = i * rowHeight + 1;
          const barY = rowY + (rowHeight - barH) / 2;
          const w = max > 0 ? (value / max) * trackW : 0;
          const share = sum > 0 ? value / sum : 0;
          const active = hover === i;
          return (
            <g key={d.key}>
              {active ? (
                <rect
                  x={0}
                  y={rowY}
                  width={Math.max(width, 1)}
                  height={rowHeight}
                  rx={4}
                  fill="var(--chart-grid)"
                  fillOpacity={0.55}
                />
              ) : null}
              <text x={0} y={rowY + rowHeight / 2 + 4} fill="var(--text-secondary)" fontSize={12}>
                {truncate(d.label, labelW - 6)}
              </text>
              <rect
                x={trackX}
                y={barY}
                width={trackW}
                height={barH}
                rx={3}
                fill="var(--chart-grid)"
                fillOpacity={0.7}
              />
              {w >= 1 ? <path d={barPath(trackX, barY, w, barH)} fill={d.color ?? color} /> : null}
              <text
                x={trackEnd + valueW}
                y={rowY + rowHeight / 2 + 4}
                textAnchor="end"
                fill="var(--text-primary)"
                fontSize={12}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatValue(value)}
              </text>
              {shareW > 0 ? (
                <text
                  x={trackEnd + valueW + shareW}
                  y={rowY + rowHeight / 2 + 4}
                  textAnchor="end"
                  fill="var(--text-muted)"
                  fontSize={11}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {`${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {hover === null || data[hover] === undefined ? null : (
        <Tooltip
          x={hoverX ?? trackEnd}
          y={hover * rowHeight + rowHeight * 1.7}
          containerWidth={width}
          title={data[hover]?.label}
          rows={[
            {
              label: 'Value',
              value: formatValue(values[hover] ?? 0),
              color: data[hover]?.color ?? color,
              strong: true,
            },
            {
              label: 'Share',
              value: sum > 0 ? `${(((values[hover] ?? 0) / sum) * 100).toFixed(1)}%` : '0%',
            },
          ]}
        />
      )}
    </div>
  );
}
