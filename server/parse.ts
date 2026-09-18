import { EFFORTS } from '../shared/types.ts';
import type { Effort, HumanTurn, SessionCost, ToolCall, UsageEvent } from '../shared/types.ts';

export type ParsedLine =
  | { kind: 'usage'; event: Omit<UsageEvent, 'cost'>; toolCalls: ToolCall[] }
  | { kind: 'cost'; cost: SessionCost }
  | { kind: 'turn'; turn: HumanTurn };

type RawUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  output_tokens_details?: { thinking_tokens?: unknown };
  cache_read_input_tokens?: unknown;
  cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown };
  cache_creation_input_tokens?: unknown;
  server_tool_use?: { web_search_requests?: unknown; web_fetch_requests?: unknown };
  service_tier?: unknown;
};

type RawAssistantLine = {
  type: 'assistant';
  requestId?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  slug?: unknown;
  effort?: unknown;
  isSidechain?: unknown;
  attributionAgent?: unknown;
  attributionSkill?: unknown;
  attributionPlugin?: unknown;
  version?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: RawUsage; content?: unknown };
};

type RawContentBlock = { type?: unknown; id?: unknown; name?: unknown; text?: unknown };

type RawUserLine = {
  type: 'user';
  uuid?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  origin?: { kind?: unknown };
  message?: { content?: unknown };
};

type RawCostStateLine = {
  type: 'cost-state';
  sessionId?: unknown;
  totalCostUSD?: unknown;
  totalDuration?: unknown;
  totalAPIDuration?: unknown;
  totalLinesAdded?: unknown;
  totalLinesRemoved?: unknown;
  startTime?: unknown;
  modelUsage?: Record<string, { costUSD?: unknown }>;
};

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toEffort(value: unknown): Effort | null {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : null;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function parseUsageEvent(raw: RawAssistantLine): ParsedLine | null {
  const usage = raw.message?.usage;
  if (usage === undefined) return null;

  const requestId = str(raw.requestId) ?? str(raw.message?.id);
  if (requestId === null) return null;

  const ts = Date.parse(str(raw.timestamp) ?? '');
  if (Number.isNaN(ts)) return null;

  const cwd = str(raw.cwd) ?? '';
  const project = cwd ? basename(cwd) : 'unknown';

  const cacheCreation = usage.cache_creation;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  if (cacheCreation !== undefined) {
    cacheWrite5m = num(cacheCreation.ephemeral_5m_input_tokens);
    cacheWrite1h = num(cacheCreation.ephemeral_1h_input_tokens);
  } else if (typeof usage.cache_creation_input_tokens === 'number') {
    cacheWrite5m = usage.cache_creation_input_tokens;
  }

  const event: Omit<UsageEvent, 'cost'> = {
    requestId,
    ts,
    sessionId: str(raw.sessionId) ?? '',
    project,
    cwd,
    gitBranch: str(raw.gitBranch),
    slug: str(raw.slug),
    model: str(raw.message?.model) ?? '',
    effort: toEffort(raw.effort),
    serviceTier: str(usage.service_tier),
    isSidechain: raw.isSidechain === true,
    attributionAgent: str(raw.attributionAgent),
    attributionSkill: str(raw.attributionSkill),
    attributionPlugin: str(raw.attributionPlugin),
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    thinking: num(usage.output_tokens_details?.thinking_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m,
    cacheWrite1h,
    webSearch: num(usage.server_tool_use?.web_search_requests),
    webFetch: num(usage.server_tool_use?.web_fetch_requests),
    version: str(raw.version),
  };

  return { kind: 'usage', event, toolCalls: parseToolCalls(raw.message?.content, event.requestId, event.ts) };
}

function parseToolCalls(content: unknown, requestId: string, ts: number): ToolCall[] {
  if (!Array.isArray(content)) return [];

  const calls: ToolCall[] = [];
  for (const block of content as RawContentBlock[]) {
    if (block?.type !== 'tool_use') continue;
    const id = str(block.id);
    const name = str(block.name);
    if (id === null || name === null) continue;
    calls.push({ id, requestId, ts, name });
  }
  return calls;
}

const PEER_MESSAGE_PREFIX = 'Another Claude session sent a message';

function hasToolResult(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return (content as RawContentBlock[]).some((block) => block?.type === 'tool_result');
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  let text = '';
  for (const block of content as RawContentBlock[]) {
    if (block?.type !== 'text') continue;
    text += str(block.text) ?? '';
  }
  return text;
}

function parseHumanTurn(raw: RawUserLine): ParsedLine | null {
  // Sidechain user lines are the prompts a subagent was handed, and isMeta lines are context
  // the harness injected. Neither is a moment a person typed.
  if (raw.isSidechain === true || raw.isMeta === true) return null;

  const content = raw.message?.content;
  if (hasToolResult(content)) return null;

  if (raw.origin !== undefined && raw.origin !== null) {
    // "task-notification" and "peer" are the agent talking to itself across sessions.
    if (str(raw.origin.kind) !== 'human') return null;
  } else if (contentText(content).startsWith(PEER_MESSAGE_PREFIX)) {
    // Claude Code 2.1.266 and later label a cross-session teammate message
    // origin.kind: "peer", but older versions journaled it with no origin at all, and there
    // were 153 such lines in the measured 30-day window. Without this prefix check they read
    // as human input and cut runs short.
    return null;
  }
  // An absent origin stays in rather than requiring origin.kind === "human": slash commands
  // (/clear, /compact), <bash-input> lines, [Request interrupted by user] and every prompt
  // from Claude Code before 2.1.186 carry no origin, and all of them are real human actions.

  const id = str(raw.uuid);
  if (id === null) return null;

  const ts = Date.parse(str(raw.timestamp) ?? '');
  if (Number.isNaN(ts)) return null;

  return { kind: 'turn', turn: { id, ts, sessionId: str(raw.sessionId) ?? '' } };
}

function parseCostState(raw: RawCostStateLine): ParsedLine | null {
  const sessionId = str(raw.sessionId);
  if (sessionId === null) return null;

  const byModel: Record<string, number> = {};
  for (const [model, modelUsage] of Object.entries(raw.modelUsage ?? {})) {
    byModel[model] = num(modelUsage?.costUSD);
  }

  const cost: SessionCost = {
    sessionId,
    totalCostUSD: num(raw.totalCostUSD),
    totalDurationMs: num(raw.totalDuration),
    totalApiDurationMs: num(raw.totalAPIDuration),
    linesAdded: num(raw.totalLinesAdded),
    linesRemoved: num(raw.totalLinesRemoved),
    startTime: num(raw.startTime),
    byModel,
  };

  return { kind: 'cost', cost };
}

export function parseLine(line: string, filePath: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null) return null;
  const type = (raw as { type?: unknown }).type;

  if (type === 'cost-state') return parseCostState(raw as RawCostStateLine);
  if (type === 'assistant') return parseUsageEvent(raw as RawAssistantLine);
  if (type === 'user') return parseHumanTurn(raw as RawUserLine);
  return null;
}
