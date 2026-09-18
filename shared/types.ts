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
  /**
   * Skill loaded in context when the request was made, e.g. "pstack:poteto-mode".
   * Marks every request the skill was live for, sidechains included, so grouping on it
   * gives what a skill actually costs. Consistent across a request's duplicate lines:
   * all 6,813 skill-attributed requests in a 30-day window carry exactly one value.
   */
  attributionSkill: string | null;
  /**
   * Plugin the skill or agent came from, e.g. "pstack". Not derivable from
   * `attributionSkill`, because plugin agents produce requests with no skill attached.
   */
  attributionPlugin: string | null;
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

/**
 * One tool invocation, at the content-block grain rather than the request grain.
 *
 * A request issues 1 to 13 of these. Claude Code writes one content block per transcript
 * line, so a request's tool calls are spread across its duplicate lines and cannot live on
 * `UsageEvent` without a merge-on-conflict upsert. `id` is the dedupe key and the store's
 * primary key; ~1% of ids repeat under session resume, exactly as `requestId` does.
 *
 * Attribution is deliberately absent. The browser already holds every `UsageEvent` keyed by
 * `requestId`, so project, model, skill, agent and cost come from joining to the request.
 * One source of truth, and nothing to keep in sync.
 */
export type ToolCall = {
  /** The `toolu_…` block id. */
  id: string;
  requestId: string;
  ts: number;
  /** Wire name, e.g. "Bash" or "mcp__Sanity__query_documents". */
  name: string;
};

/**
 * Server and tool for an MCP call, or null for a built-in tool.
 *
 * Derived from `ToolCall.name`, never from the transcript's `attributionMcpServer` and
 * `attributionMcpTool` fields. Those disagree with the block on their own line (203 lines
 * call a claude-in-chrome tool with a null server; the tool field names a different tool
 * than the block on 60+ lines per pair), so they read as lagging context markers rather
 * than a record of the call.
 */
export function mcpTarget(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const split = rest.indexOf('__');
  if (split <= 0) return null;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

/**
 * One moment a person typed into a session, at the transcript-line grain.
 *
 * Neither `UsageEvent` nor `ToolCall` records when a human acted, so nothing else can tell a
 * stretch the person was driving from a stretch the agent ran alone. These are the boundary
 * markers that split a session into runs.
 *
 * Attribution is absent for the same reason it is on `ToolCall`: the browser already holds
 * every `UsageEvent`, so project, model and cost come from joining to the session's requests.
 */
export type HumanTurn = {
  /** Transcript line `uuid`. Dedupe key and the store's primary key. */
  id: string;
  ts: number;
  sessionId: string;
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
  /** Ordered oldest-first, and only for requests inside `events`. */
  toolCalls: ToolCall[];
  /** Ordered oldest-first, over the same window as `events`. */
  humanTurns: HumanTurn[];
  /** True while the initial 30-day backfill is still running. */
  backfilling: boolean;
};

/** Sent whenever the tailer commits newly seen requests. */
export type Delta = {
  type: 'delta';
  serverNow: number;
  events: UsageEvent[];
  sessionCosts: SessionCost[];
  toolCalls: ToolCall[];
  humanTurns: HumanTurn[];
};

/** Keeps the connection warm and the freshness clock accurate when idle. */
export type Heartbeat = { type: 'heartbeat'; serverNow: number };

/** Emitted when backfill finishes, so the UI can drop its loading state. */
export type BackfillDone = { type: 'backfill-done'; serverNow: number; total: number };

export type ServerMessage = Snapshot | Delta | Heartbeat | BackfillDone;
