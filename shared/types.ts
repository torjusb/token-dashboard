/**
 * The contract between the tailer, the store, the stream and the browser.
 * Every number in the dashboard traces back to a UsageEvent.
 */

export const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * One billed API request.
 *
 * Claude Code writes the same request to the transcript once per content block,
 * so the raw line count is ~2x the request count. `requestId` is the dedupe key
 * and the store's primary key; nothing may aggregate raw lines.
 */
export type UsageEvent = {
  requestId: string;
  ts: number;
  sessionId: string;
  /** Basename of `cwd`, the human-facing project name. */
  project: string;
  cwd: string;
  gitBranch: string | null;
  /** Session title Claude Code derived from the first prompt. */
  slug: string | null;
  model: string;
  effort: Effort | null;
  serviceTier: string | null;
  /** True for subagent traffic. Roughly 40% of tokens. */
  isSidechain: boolean;
  /** Subagent type for sidechain events, e.g. "Explore". */
  attributionAgent: string | null;
  input: number;
  output: number;
  /** Subset of `output`, already counted in it. Never add to a token total. */
  thinking: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  webFetch: number;
  /** Derived from the pricing table, in USD. */
  cost: number;
  /** Claude Code version that made the request. */
  version: string | null;
};

/** Claude Code's own per-session cost accounting, used to validate `cost`. */
export type SessionCost = {
  sessionId: string;
  totalCostUSD: number;
  totalDurationMs: number;
  totalApiDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
  startTime: number;
  /** Per-model costUSD as reported by Claude Code. */
  byModel: Record<string, number>;
};

/** Sent once on connect, before any deltas. */
export type Snapshot = {
  type: 'snapshot';
  /** Server clock, so the client can render "live" freshness honestly. */
  serverNow: number;
  windowDays: number;
  /** Ordered oldest-first. */
  events: UsageEvent[];
  sessionCosts: SessionCost[];
  /** True while the initial 30-day backfill is still running. */
  backfilling: boolean;
};

/** Sent whenever the tailer commits newly seen requests. */
export type Delta = {
  type: 'delta';
  serverNow: number;
  events: UsageEvent[];
  sessionCosts: SessionCost[];
};

/** Keeps the connection warm and the freshness clock accurate when idle. */
export type Heartbeat = { type: 'heartbeat'; serverNow: number };

/** Emitted when backfill finishes, so the UI can drop its loading state. */
export type BackfillDone = { type: 'backfill-done'; serverNow: number; total: number };

export type ServerMessage = Snapshot | Delta | Heartbeat | BackfillDone;
