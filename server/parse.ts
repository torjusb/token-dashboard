import { EFFORTS } from '../shared/types.ts';
import type { Effort, SessionCost, UsageEvent } from '../shared/types.ts';

export type ParsedLine = { kind: 'usage'; event: Omit<UsageEvent, 'cost'> } | { kind: 'cost'; cost: SessionCost };

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
  version?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: RawUsage };
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

  return { kind: 'usage', event };
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
  return null;
}
