import { useRef, useState } from 'react';
import { SEQUENTIAL_EMPTY, SEQUENTIAL_RAMP, formatCompact } from '../lib/format.ts';
import { clamp, truncate, useContainerWidth } from './scale.ts';
import { Tooltip } from './Tooltip.tsx';

export type HeatCell = { row: number; col: number; value: number };

export type HeatmapProps = {
  cells: readonly HeatCell[];
  rowLabels: readonly string[];
  colLabels: readonly string[];
  /** Upper end of the ramp. Defaults to the largest cell. */
  max?: number;
  ramp?: readonly string[];
  /** `sqrt` keeps a skewed grid readable when a few cells dwarf the rest. */
  ramping?: 'linear' | 'sqrt';
  formatValue?: (value: number) => string;
  /** Upper bound on cell height. Cell width always fills the container. */
  rowHeight?: number;
  ariaLabel?: string;
  legendLabel?: string;
};

const GAP = 2;

export function Heatmap({
  cells,
  rowLabels,
  colLabels,
  max,
  ramp = SEQUENTIAL_RAMP,
  ramping = 'linear',
  formatValue = formatCompact,
  rowHeight = 24,
  ariaLabel,
  legendLabel = 'Volume',
}: HeatmapProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(box);
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);

  const byKey = new Map(cells.map((c) => [`${c.row}:${c.col}`, Math.max(0, c.value)]));
  const at = (row: number, col: number) => byKey.get(`${row}:${col}`) ?? 0;
  const peak = max !== undefined && max > 0 ? max : Math.max(0, ...cells.map((c) => c.value));

  const labelW = clamp(8 + Math.max(0, ...rowLabels.map((l) => l.length)) * 6.6, 24, 72);
  const padTop = 16;
  const cols = Math.max(1, colLabels.length);
  const rows = Math.max(1, rowLabels.length);
  const cellW = clamp(Math.floor((width - labelW) / cols), 9, 80);
  const cellH = Math.min(cellW, rowHeight);
  const gridW = cellW * cols;
  const height = padTop + rows * cellH;

  const step = (value: number) => {
    if (value <= 0 || peak <= 0) return null;
    const t = ramping === 'sqrt' ? Math.sqrt(value / peak) : value / peak;
    return (
      ramp[clamp(Math.ceil(t * ramp.length) - 1, 0, ramp.length - 1)] ??
      ramp[ramp.length - 1] ??
      null
    );
  };

  const colStride = Math.ceil((cols * 46) / Math.max(1, gridW));
  const hottest = cells.reduce<HeatCell | null>(
    (best, c) => (best === null || c.value > best.value ? c : best),
    null,
  );

  const summary =
    ariaLabel ??
    (peak > 0 && hottest !== null
      ? `Heatmap, ${rows} rows by ${cols} columns, peak ${formatValue(hottest.value)} at ${
          rowLabels[hottest.row] ?? hottest.row
        } ${colLabels[hottest.col] ?? hottest.col}`
      : `Heatmap, ${rows} rows by ${cols} columns, no activity`);

  const hovered = hover === null ? null : { ...hover, value: at(hover.row, hover.col) };

  return (
    <div ref={box} style={{ position: 'relative', width: '100%' }}>
      <svg
        width={labelW + gridW}
        height={height}
        role="img"
        aria-label={summary}
        tabIndex={0}
        style={{ display: 'block', touchAction: 'none', outlineOffset: 2 }}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover((h) => h ?? { row: 0, col: 0 })}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
          if (dx === 0 && dy === 0) return;
          e.preventDefault();
          const current = hover ?? { row: 0, col: 0 };
          setHover({
            row: clamp(current.row + dy, 0, rows - 1),
            col: clamp(current.col + dx, 0, cols - 1),
          });
        }}
      >
        {colLabels.map((label, col) =>
          col % colStride === 0 ? (
            <text
              key={`c${col}`}
              x={labelW + col * cellW + cellW / 2}
              y={11}
              textAnchor="middle"
              fill="var(--text-muted)"
              fontSize={10}
            >
              {truncate(label, cellW * colStride - 2, 5.6)}
            </text>
          ) : null,
        )}

        {rowLabels.map((label, row) => (
          <text
            key={`r${row}`}
            x={labelW - 8}
            y={padTop + row * cellH + cellH / 2 + 3.5}
            textAnchor="end"
            fill="var(--text-muted)"
            fontSize={clamp(cellH - 2, 7, 10)}
          >
            {truncate(label, labelW - 10, 5.6)}
          </text>
        ))}

        {rowLabels.map((_, row) =>
          colLabels.map((_, col) => {
            const value = at(row, col);
            const fill = step(value);
            const active = hover !== null && hover.row === row && hover.col === col;
            return (
              <rect
                key={`${row}:${col}`}
                x={labelW + col * cellW}
                y={padTop + row * cellH}
                width={Math.max(1, cellW - GAP)}
                height={Math.max(1, cellH - GAP)}
                rx={2}
                fill={fill ?? SEQUENTIAL_EMPTY}
                stroke={active ? 'var(--text-primary)' : 'none'}
                strokeWidth={active ? 2 : 0}
                onPointerEnter={() => setHover({ row, col })}
              />
            );
          }),
        )}
      </svg>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 8,
          fontSize: 11,
          color: 'var(--text-muted)',
        }}
      >
        <span>{legendLabel}</span>
        <span>0</span>
        <span style={{ display: 'flex', gap: 2 }} aria-hidden="true">
          {ramp.map((c) => (
            <span key={c} style={{ width: 14, height: 8, borderRadius: 1, background: c }} />
          ))}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatValue(peak)}</span>
        {ramping === 'sqrt' ? <span>(square-root steps)</span> : null}
      </div>

      <div
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
        }}
      >
        <table>
          <caption>{summary}</caption>
          <thead>
            <tr>
              <th scope="col" />
              {colLabels.map((label, col) => (
                <th key={col} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowLabels.map((label, row) => (
              <tr key={row}>
                <th scope="row">{label}</th>
                {colLabels.map((_, col) => (
                  <td key={col}>{formatValue(at(row, col))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hovered === null ? null : (
        <Tooltip
          x={labelW + hovered.col * cellW + cellW / 2}
          y={padTop + hovered.row * cellH + cellH / 2}
          containerWidth={width}
          title={`${rowLabels[hovered.row] ?? ''} ${colLabels[hovered.col] ?? ''}`.trim()}
          rows={[
            {
              label: legendLabel,
              value: formatValue(hovered.value),
              strong: true,
            },
          ]}
        />
      )}
    </div>
  );
}
