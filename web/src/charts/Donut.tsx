import { useRef, useState } from 'react';
import { formatCompact } from '../lib/format.ts';
import { useContainerWidth } from './scale.ts';
import { Tooltip } from './Tooltip.tsx';

export type DonutSegment = { key: string; label: string; value: number; color: string };

export type DonutProps = {
  segments: readonly DonutSegment[];
  size?: number;
  thickness?: number;
  centerValue?: string;
  centerLabel?: string;
  formatValue?: (value: number) => string;
  ariaLabel?: string;
  emptyMessage?: string;
};

function ringPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number,
): string {
  const at = (r: number, a: number) =>
    `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${at(rOuter, a0)}A${rOuter} ${rOuter} 0 ${large} 1 ${at(rOuter, a1)}L${at(rInner, a1)}A${rInner} ${rInner} 0 ${large} 0 ${at(rInner, a0)}Z`;
}

export function Donut({
  segments,
  size = 200,
  thickness = 26,
  centerValue,
  centerLabel,
  formatValue = formatCompact,
  ariaLabel,
  emptyMessage = 'No data in range',
}: DonutProps) {
  const box = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(box, size);
  const [hover, setHover] = useState<string | null>(null);

  const rows = segments.map((s) => ({
    ...s,
    value: Number.isFinite(s.value) ? Math.max(0, s.value) : 0,
  }));
  const total = rows.reduce((a, b) => a + b.value, 0);
  const visible = rows.filter((s) => s.value > 0);

  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = Math.max(8, rOuter - thickness);
  const gap = visible.length > 1 ? 2 / rOuter : 0;

  let cursor = -Math.PI / 2;
  const arcs = visible.map((s) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const a0 = cursor + (sweep > gap * 2 ? gap / 2 : 0);
    const a1 = cursor + sweep - (sweep > gap * 2 ? gap / 2 : 0);
    cursor += sweep;
    return { ...s, a0, a1, mid: (a0 + a1) / 2, share: s.value / total };
  });

  const svgWidth = Math.min(containerWidth, size);
  const k = svgWidth / size;
  const active = arcs.find((a) => a.key === hover);

  const summary =
    ariaLabel ??
    (total > 0
      ? `Donut chart, ${visible.length} segments, total ${formatValue(total)}, largest ${
          [...visible].sort((a, b) => b.value - a.value)[0]?.label ?? ''
        }`
      : emptyMessage);

  return (
    <div
      style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', width: '100%' }}
    >
      <div ref={box} style={{ position: 'relative', flex: '0 1 auto', minWidth: 0, lineHeight: 0 }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width={svgWidth}
          height={svgWidth}
          role="img"
          aria-label={summary}
          style={{ display: 'block', maxWidth: '100%', height: 'auto', overflow: 'visible' }}
        >
          <circle
            cx={cx}
            cy={cy}
            r={(rOuter + rInner) / 2}
            fill="none"
            stroke="var(--chart-grid)"
            strokeWidth={rOuter - rInner}
          />
          {arcs.length === 1 && arcs[0] !== undefined ? (
            <circle
              cx={cx}
              cy={cy}
              r={(rOuter + rInner) / 2}
              fill="none"
              stroke={arcs[0].color}
              strokeWidth={rOuter - rInner}
              onPointerEnter={() => setHover(arcs[0]?.key ?? null)}
              onPointerLeave={() => setHover(null)}
            />
          ) : (
            arcs.map((a) => (
              <path
                key={a.key}
                d={ringPath(cx, cy, hover === a.key ? rOuter + 2 : rOuter, rInner, a.a0, a.a1)}
                fill={a.color}
                onPointerEnter={() => setHover(a.key)}
                onPointerLeave={() => setHover(null)}
              />
            ))
          )}
          <text
            x={cx}
            y={cy + (centerLabel === undefined ? 8 : 2)}
            textAnchor="middle"
            fill="var(--text-primary)"
            fontSize={size * 0.13}
            fontWeight={600}
          >
            {centerValue ?? formatValue(total)}
          </text>
          {centerLabel === undefined ? null : (
            <text
              x={cx}
              y={cy + size * 0.11}
              textAnchor="middle"
              fill="var(--text-muted)"
              fontSize={11}
            >
              {centerLabel}
            </text>
          )}
        </svg>

        {active === undefined ? null : (
          <Tooltip
            x={(cx + Math.cos(active.mid) * rOuter * 0.85) * k}
            y={(cy + Math.sin(active.mid) * rOuter * 0.85) * k}
            containerWidth={svgWidth}
            title={active.label}
            rows={[
              {
                label: 'Value',
                value: formatValue(active.value),
                color: active.color,
                strong: true,
              },
              { label: 'Share', value: `${(active.share * 100).toFixed(1)}%` },
            ]}
          />
        )}
      </div>

      <ul
        style={{
          flex: '1 1 160px',
          listStyle: 'none',
          margin: 0,
          padding: 0,
          fontSize: 12,
          display: 'grid',
          gap: 4,
        }}
      >
        {rows.length === 0 ? (
          <li style={{ color: 'var(--text-muted)' }}>{emptyMessage}</li>
        ) : (
          rows.map((s) => (
            <li
              key={s.key}
              onPointerEnter={() => setHover(s.key)}
              onPointerLeave={() => setHover(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--text-secondary)',
                opacity: hover === null || hover === s.key ? 1 : 0.6,
              }}
            >
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
              <span
                style={{
                  flex: '1 1 auto',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.label}
              </span>
              <span style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                {formatValue(s.value)}
              </span>
              <span
                style={{
                  color: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                  width: 44,
                  textAlign: 'right',
                }}
              >
                {total > 0 ? `${((s.value / total) * 100).toFixed(1)}%` : '0%'}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
