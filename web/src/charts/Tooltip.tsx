import type { CSSProperties } from 'react';

export type TooltipRow = { label: string; value: string; color?: string; strong?: boolean };

export type TooltipProps = {
  x: number;
  y: number;
  containerWidth: number;
  title?: string;
  rows: readonly TooltipRow[];
};

const WIDTH = 200;

const shell: CSSProperties = {
  position: 'absolute',
  zIndex: 2,
  pointerEvents: 'none',
  minWidth: 120,
  maxWidth: WIDTH,
  padding: '7px 9px',
  borderRadius: 6,
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  boxShadow: 'var(--shadow-2)',
  color: 'var(--text-primary)',
  fontSize: 12,
  lineHeight: 1.45,
};

export function Tooltip({ x, y, containerWidth, title, rows }: TooltipProps) {
  const flip = containerWidth - x < WIDTH + 24 && x > WIDTH + 24;
  const left = flip
    ? Math.max(4, x - 12)
    : Math.max(4, Math.min(x + 12, Math.max(4, containerWidth - WIDTH - 4)));
  return (
    <div
      role="tooltip"
      style={{
        ...shell,
        left,
        top: Math.max(0, y),
        transform: `translate(${flip ? '-100%' : '0'}, -50%)`,
      }}
    >
      {title === undefined ? null : (
        <div style={{ color: 'var(--text-secondary)', marginBottom: 4, fontSize: 11 }}>{title}</div>
      )}
      {rows.map((row) => (
        <div
          key={row.label}
          style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {row.color === undefined ? null : (
              <span
                aria-hidden="true"
                style={{
                  width: 12,
                  height: 2,
                  borderRadius: 1,
                  background: row.color,
                  flex: '0 0 auto',
                }}
              />
            )}
            <span
              style={{
                color: 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.label}
            </span>
          </span>
          <span
            style={{
              fontVariantNumeric: 'tabular-nums',
              fontWeight: row.strong === true ? 600 : 500,
              color: 'var(--text-primary)',
            }}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}
