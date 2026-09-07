import { useEffect, useState, type RefObject } from 'react';

export type ScaleKind = 'linear' | 'log';

export type Scale = {
  kind: ScaleKind;
  domain: readonly [number, number];
  range: readonly [number, number];
  to: (value: number) => number;
  from: (pixel: number) => number;
};

export type Pt = { x: number; y: number };

function widen(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi > lo) return [lo, hi];
  if (lo === 0) return [0, 1];
  const pad = Math.abs(lo) * 0.5;
  return [lo - pad, lo + pad];
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const [d0, d1] = widen(domain[0], domain[1]);
  const [r0, r1] = range;
  const dSpan = d1 - d0;
  const rSpan = r1 - r0;
  return {
    kind: 'linear',
    domain: [d0, d1],
    range,
    to: (v) => r0 + ((v - d0) / dSpan) * rSpan,
    from: (p) => (rSpan === 0 ? d0 : d0 + ((p - r0) / rSpan) * dSpan),
  };
}

export function logScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale {
  const lo = domain[0] > 0 && Number.isFinite(domain[0]) ? domain[0] : 1;
  const hi = domain[1] > lo ? domain[1] : lo * 10;
  const [r0, r1] = range;
  const l0 = Math.log10(lo);
  const lSpan = Math.log10(hi) - l0;
  const rSpan = r1 - r0;
  return {
    kind: 'log',
    domain: [lo, hi],
    range,
    to: (v) => r0 + ((Math.log10(Math.max(v, lo)) - l0) / lSpan) * rSpan,
    from: (p) => 10 ** (l0 + (rSpan === 0 ? 0 : ((p - r0) / rSpan) * lSpan)),
  };
}

export function tickStep(span: number, count: number): number {
  const target = Math.abs(span) / Math.max(1, count);
  if (!(target > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;
  const multiple = normalized >= 7.5 ? 10 : normalized >= 3.5 ? 5 : normalized >= 1.5 ? 2 : 1;
  return multiple * magnitude;
}

export function niceDomain(min: number, max: number, count = 5): [number, number] {
  const [lo, hi] = widen(min, max);
  const step = tickStep(hi - lo, count);
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

/** `minStep` keeps integer data (tokens, requests) off fractional ticks like 0.2. */
export function axisTicks(scale: Scale, count = 5, minStep = 0): number[] {
  const [d0, d1] = scale.domain;
  if (scale.kind === 'log') {
    const first = Math.floor(Math.log10(d0));
    const last = Math.ceil(Math.log10(d1));
    const decades: number[] = [];
    for (let e = first; e <= last; e += 1) decades.push(10 ** e);
    const inside = decades.filter((v) => v >= d0 * 0.999 && v <= d1 * 1.001);
    const stride = Math.ceil(inside.length / Math.max(2, count));
    return inside.filter((_, i) => i % stride === 0);
  }
  const step = Math.max(tickStep(d1 - d0, count), minStep);
  const out: number[] = [];
  for (let v = Math.ceil(d0 / step) * step; v <= d1 + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return out;
}

export function linePath(points: readonly Pt[]): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('');
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function nearestIndex(values: readonly number[], target: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const gap = Math.abs((values[i] ?? 0) - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

/** SVG <text> cannot ellipsize, so labels are trimmed against a measured average glyph width. */
export function truncate(text: string, maxWidth: number, charWidth = 6.4): string {
  const budget = Math.floor(maxWidth / charWidth);
  if (budget <= 1) return '';
  return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
}

export function useContainerWidth(ref: RefObject<HTMLElement | null>, fallback = 640): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === 'number') setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width > 0 ? width : fallback;
}
