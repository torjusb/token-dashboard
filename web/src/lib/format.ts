import type { Effort, TokenKind } from '../../../shared/types.ts';

const MISSING = '–';

const NUM_LOCALE = 'en-US';

const countFmt = new Intl.NumberFormat(NUM_LOCALE, { maximumFractionDigits: 0 });
const money2Fmt = new Intl.NumberFormat(NUM_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dayFmt = new Intl.DateTimeFormat(NUM_LOCALE, { month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(NUM_LOCALE, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateTimeFmt = new Intl.DateTimeFormat(NUM_LOCALE, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const UNITS: ReadonlyArray<readonly [number, string]> = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
];

/**
 * Rounds to 4 significant figures before choosing the unit so 999,999 lands on
 * "1.00M" instead of "1000.0k", then keeps 3-4 digits of mantissa so a large
 * mantissa reads as 435.6M rather than collapsing to 0.44B.
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return MISSING;
  const sign = n < 0 ? '-' : '';
  const abs = Math.round(Math.abs(n));
  const magnitude = Number(abs.toPrecision(4));
  for (const [limit, suffix] of UNITS) {
    if (magnitude >= limit) {
      const scaled = magnitude / limit;
      const digits = Math.max(1, 2 - Math.floor(Math.log10(scaled)));
      return sign + scaled.toFixed(digits) + suffix;
    }
  }
  return sign + countFmt.format(magnitude);
}

export const formatTokens = formatCompact;

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return MISSING;
  return countFmt.format(Math.round(n));
}

export function formatCost(n: number): string {
  if (!Number.isFinite(n)) return MISSING;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs === 0) return '$0.00';
  if (abs >= 0.01) return sign + '$' + money2Fmt.format(abs);
  if (abs < 1e-8) return sign + '<$0.00000001';
  const decimals = Math.min(8, 1 - Math.floor(Math.log10(abs)));
  return sign + '$' + abs.toFixed(decimals).replace(/0+$/, '');
}

export function formatCostCompact(n: number): string {
  if (!Number.isFinite(n)) return MISSING;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs === 0) return '$0.00';
  if (abs >= 1000) return sign + '$' + formatCompact(abs);
  if (abs < 0.01) return sign + '<$0.01';
  return sign + '$' + abs.toFixed(2);
}

export function formatPercent(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return MISSING;
  const pct = x * 100;
  const smallest = 10 ** -digits;
  if (pct !== 0 && Math.abs(pct) < smallest / 2) {
    return (pct < 0 ? '>-' : '<') + smallest.toFixed(digits) + '%';
  }
  return pct.toFixed(digits) + '%';
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return MISSING;
  if (ms === 0) return '0s';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const total = Math.round(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

function span(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatRelative(ts: number, now: number): string {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return MISSING;
  const diff = now - ts;
  if (diff < -60_000) return 'in ' + span(-diff);
  if (diff < 5000) return 'just now';
  return span(diff) + ' ago';
}

export function formatDayLabel(ts: number): string {
  if (!Number.isFinite(ts)) return MISSING;
  return dayFmt.format(ts);
}

export function formatTimeLabel(ts: number): string {
  if (!Number.isFinite(ts)) return MISSING;
  return timeFmt.format(ts);
}

export function formatDateTime(ts: number): string {
  if (!Number.isFinite(ts)) return MISSING;
  return dateTimeFmt.format(ts).replace(' at ', ', ');
}

export function modelLabel(model: string): string {
  const raw = model.trim();
  if (raw.length === 0) return 'Unknown';
  if (raw === '<synthetic>') return 'Synthetic';

  const context = raw.match(/\[(\d+m)\]$/i);
  const stripped = raw
    .replace(/\[\d+m\]$/i, '')
    .replace(/^claude[-.]/i, '')
    .replace(/-\d{8}$/, '');

  const words: string[] = [];
  const numbers: string[] = [];
  for (const part of stripped.split(/[-.]/)) {
    if (part.length === 0 || part === 'latest') continue;
    if (/^\d+$/.test(part)) numbers.push(part);
    else words.push(part.charAt(0).toUpperCase() + part.slice(1));
  }

  const label = [words.join(' '), numbers.join('.')].filter((s) => s.length > 0).join(' ');
  const suffix = context ? ` (${context[1]!.toUpperCase()})` : '';
  return (label.length > 0 ? label : raw) + suffix;
}

/**
 * Slots ascend with the measured 30-day share of each model, so a chart sorted
 * by volume renders the palette in its validated adjacent order. Slots 6-8 stay
 * out of the registry as the pool for models that appear later, so a new model
 * gets its own hue instead of impersonating a registered one.
 */
const MODEL_SERIES: Readonly<Record<string, number>> = {
  'opus 5': 1,
  'sonnet 5': 2,
  'opus 4.8': 3,
  'fable 5': 4,
  'haiku 4.5': 5,
};

const UNKNOWN_SLOTS = [6, 7, 8];

const FAMILY_ALIAS: Readonly<Record<string, string>> = {
  opus: 'opus 5',
  sonnet: 'sonnet 5',
  haiku: 'haiku 4.5',
  fable: 'fable 5',
};

export function colorForModel(model: string): string {
  const label = modelLabel(model);
  if (label === 'Synthetic' || label === 'Unknown') return 'var(--series-other)';

  const bare = label.replace(/\s*\(\d+M\)$/, '').toLowerCase();
  const key = FAMILY_ALIAS[bare] ?? bare;
  const slot = MODEL_SERIES[key];
  if (slot !== undefined) return `var(--series-${slot})`;

  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % UNKNOWN_SLOTS.length;
  return `var(--series-${UNKNOWN_SLOTS[hash]})`;
}

export const TOKEN_KIND_LABELS: Record<TokenKind, string> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite5m: 'Cache write 5m',
  cacheWrite1h: 'Cache write 1h',
};

const TOKEN_KIND_SERIES: Record<TokenKind, string> = {
  input: 'var(--series-1)',
  output: 'var(--series-2)',
  cacheRead: 'var(--series-3)',
  cacheWrite5m: 'var(--series-4)',
  cacheWrite1h: 'var(--series-5)',
};

export function colorForTokenKind(kind: TokenKind): string {
  return TOKEN_KIND_SERIES[kind];
}

/** Low-to-high magnitude. The anchor flips in dark mode inside theme.css. */
export const SEQUENTIAL_RAMP: readonly string[] = [
  'var(--seq-1)',
  'var(--seq-2)',
  'var(--seq-3)',
  'var(--seq-4)',
  'var(--seq-5)',
  'var(--seq-6)',
  'var(--seq-7)',
];

/** The empty cell in a heatmap, so "no data" never reads as the lowest bucket. */
export const SEQUENTIAL_EMPTY = 'var(--seq-empty)';

/** Categorical slots in their validated adjacent order. */
export const SERIES_COLORS: readonly string[] = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
];

const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const EFFORT_SERIES: Record<Effort, string> = {
  low: 'var(--effort-low)',
  medium: 'var(--effort-medium)',
  high: 'var(--effort-high)',
  xhigh: 'var(--effort-xhigh)',
  max: 'var(--effort-max)',
};

export function effortLabel(effort: Effort | null): string {
  return effort === null ? 'Unspecified' : EFFORT_LABELS[effort];
}

export function colorForEffort(effort: Effort | null): string {
  return effort === null ? 'var(--series-other)' : EFFORT_SERIES[effort];
}
