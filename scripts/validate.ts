import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolCall, UsageEvent } from '../shared/types.ts';
import { PRICING, WEB_SEARCH_USD } from '../server/pricing.ts';
import type { Rate } from '../server/pricing.ts';
import { createScanner } from '../server/scan.ts';
import { openStore } from '../server/store.ts';
import type { Store } from '../server/store.ts';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const TRANSCRIPTS_ROOT = join(homedir(), '.claude', 'projects');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type CheckResult = { name: string; pass: boolean; lines: string[] };

function pct(a: number, b: number): number {
  return b === 0 ? (a === 0 ? 0 : Infinity) : (Math.abs(a - b) / Math.abs(b)) * 100;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function parseArgs(argv: string[]): string {
  const dbFlag = argv.indexOf('--db');
  if (dbFlag === -1) return join(repoRoot, 'data', 'usage.db');
  const value = argv[dbFlag + 1];
  if (!value) throw new Error('--db requires a path');
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => join(e.parentPath, e.name));
}

/**
 * Every raw assistant line inside the window that carries usage and a usable requestId,
 * decoded but otherwise untouched. Written from scratch against the transcript format and
 * deliberately not calling server/parse.ts, so the checks built on it can catch a parser bug
 * instead of restating one.
 */
async function* rawAssistantLines(
  cutoff: number,
): AsyncGenerator<{ rec: Record<string, unknown>; requestId: string }> {
  for (const file of await walkJsonlFiles(TRANSCRIPTS_ROOT)) {
    try {
      if (statSync(file).mtimeMs < cutoff) continue;
    } catch {
      continue;
    }

    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const line of text.split('\n')) {
      if (!line.includes('"type":"assistant"')) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof raw !== 'object' || raw === null) continue;
      const rec = raw as Record<string, unknown>;
      if (rec.type !== 'assistant') continue;
      const message = rec.message as Record<string, unknown> | undefined;
      if (typeof message !== 'object' || message === null || message.usage === undefined) continue;

      const ts = Date.parse(typeof rec.timestamp === 'string' ? rec.timestamp : '');
      if (Number.isNaN(ts) || ts < cutoff) continue;

      const requestId = typeof rec.requestId === 'string' ? rec.requestId : message.id;
      if (typeof requestId !== 'string' || requestId.length === 0) continue;

      yield { rec, requestId };
    }
  }
}

async function independentRequestIdCount(
  cutoff: number,
): Promise<{ rawLines: number; distinctIds: number }> {
  let rawLines = 0;
  const ids = new Set<string>();

  for await (const { requestId } of rawAssistantLines(cutoff)) {
    rawLines++;
    ids.add(requestId);
  }

  return { rawLines, distinctIds: ids.size };
}

async function checkDedupe(store: Store, cutoff: number): Promise<CheckResult> {
  const { rawLines, distinctIds } = await independentRequestIdCount(cutoff);
  const storeCount = store.countEvents();
  const ratio = distinctIds === 0 ? 0 : rawLines / distinctIds;
  const error = pct(storeCount, distinctIds);
  const pass = distinctIds > 0 && error <= 0.5;

  return {
    name: 'DEDUPE',
    pass,
    lines: [
      `raw qualifying lines: ${rawLines}`,
      `independent distinct requestIds: ${distinctIds}`,
      `ratio (raw / distinct): ${ratio.toFixed(2)}x`,
      `store countEvents(): ${storeCount}`,
      `error vs independent count: ${error.toFixed(3)}% (fail above 0.5%)`,
    ],
  };
}

type ModelUsageRow = {
  sessionId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearch: number;
  costUSD: number;
};

type SessionUsage = { sessionId: string; startTime: number; rows: ModelUsageRow[] };

/**
 * Claude Code's own accounting, one row per model per session, carrying both the token counts
 * it billed and the dollars it charged for them. The store keeps only the dollars, so this
 * reads the raw records to get the counts alongside.
 */
async function readModelUsage(root: string): Promise<SessionUsage[]> {
  const latest = new Map<string, SessionUsage>();
  for (const filePath of await walkJsonlFiles(root)) {
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"cost-state"')) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d?.type !== 'cost-state') continue;
      const sessionId = d.sessionId;
      const usage = d.modelUsage;
      if (typeof sessionId !== 'string' || typeof usage !== 'object' || usage === null) continue;
      const rows: ModelUsageRow[] = Object.entries(usage).map(([model, u]: [string, any]) => ({
        sessionId,
        model,
        input: u?.inputTokens ?? 0,
        output: u?.outputTokens ?? 0,
        cacheRead: u?.cacheReadInputTokens ?? 0,
        cacheWrite: u?.cacheCreationInputTokens ?? 0,
        webSearch: u?.webSearchRequests ?? 0,
        costUSD: u?.costUSD ?? 0,
      }));
      latest.set(sessionId, { sessionId, startTime: d.startTime ?? 0, rows });
    }
  }
  return [...latest.values()];
}

function rateFor(model: string): Rate | null {
  const base = model.replace('[1m]', '');
  let best: Rate | null = null;
  let bestLen = -1;
  for (const [prefix, rate] of Object.entries(PRICING)) {
    if (base.startsWith(prefix) && prefix.length > bestLen) {
      best = rate;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * The only exact test of the rate table. Claude Code reports the token counts AND the dollars
 * for each model in a session, so re-pricing its own counts must reproduce its own total.
 *
 * The one ambiguity is that it lumps 5-minute and 1-hour cache writes into a single
 * `cacheCreationInputTokens`, and those bill at different rates. Rather than guess the split,
 * price the row twice, once as all-5m and once as all-1h, and require the reported cost to
 * fall in between. A correct table always brackets it; a wrong one usually will not.
 */
async function checkPricing(): Promise<CheckResult> {
  const sessions = await readModelUsage(TRANSCRIPTS_ROOT);
  const rows = sessions.flatMap((s) => s.rows).filter((r) => r.costUSD > 0);
  if (rows.length === 0) {
    return { name: 'PRICING', pass: false, lines: ['no cost-state modelUsage rows with a non-zero cost'] };
  }

  const unpriced: string[] = [];
  const outside: Array<{ row: ModelUsageRow; low: number; high: number }> = [];
  let exact = 0;

  for (const row of rows) {
    const rate = rateFor(row.model);
    if (rate === null) {
      unpriced.push(row.model);
      continue;
    }
    const base =
      row.input * rate.input +
      row.output * rate.output +
      row.cacheRead * rate.cacheRead +
      row.webSearch * WEB_SEARCH_USD;
    const low = base + row.cacheWrite * rate.cacheWrite5m;
    const high = base + row.cacheWrite * rate.cacheWrite1h;
    const tolerance = Math.max(1e-6, row.costUSD * 1e-9);
    if (row.costUSD >= low - tolerance && row.costUSD <= high + tolerance) exact++;
    else outside.push({ row, low, high });
  }

  const checked = rows.length - unpriced.length;
  const pass = outside.length === 0 && unpriced.length === 0 && checked > 0;

  return {
    name: 'PRICING',
    pass,
    lines: [
      `cost-state model rows re-priced: ${checked}`,
      `reported cost bracketed by the 5m/1h bounds: ${exact}`,
      `outside the bounds: ${outside.length} (any is a failure)`,
      ...outside
        .slice(0, 5)
        .map(
          (o) =>
            `  ${o.row.sessionId.slice(0, 8)} ${o.row.model}: reported ${fmtUsd(o.row.costUSD)} ` +
            `outside [${fmtUsd(o.low)}, ${fmtUsd(o.high)}]`,
        ),
      unpriced.length === 0
        ? 'models with no rate: none'
        : `models with no rate: ${[...new Set(unpriced)].join(', ')}`,
    ],
  };
}

/**
 * What share of the requests Claude Code billed actually reached a transcript. This is a
 * property of the data source, not of our code, so it is reported rather than tuned: Claude
 * Code bills internal utility calls (titles, summaries) and some assistant turns that it
 * never writes as a `type:"assistant"` line, and no amount of parsing recovers them. The
 * floor exists to catch a real ingest regression, which would drop coverage far below this.
 */
const COVERAGE_FLOOR = 0.85;

async function checkCoverage(store: Store): Promise<CheckResult> {
  const sessions = await readModelUsage(TRANSCRIPTS_ROOT);
  const events = store.eventsSince(0);
  const bySession = new Map<string, UsageEvent[]>();
  for (const e of events) {
    let list = bySession.get(e.sessionId);
    if (list === undefined) bySession.set(e.sessionId, (list = []));
    list.push(e);
  }

  const billed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const held = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let compared = 0;

  for (const session of sessions) {
    const scoped = (bySession.get(session.sessionId) ?? []).filter((e) => e.ts >= session.startTime);
    if (scoped.length === 0) continue;
    compared++;
    for (const row of session.rows) {
      billed.input += row.input;
      billed.output += row.output;
      billed.cacheRead += row.cacheRead;
      billed.cacheWrite += row.cacheWrite;
      billed.cost += row.costUSD;
    }
    for (const e of scoped) {
      held.input += e.input;
      held.output += e.output;
      held.cacheRead += e.cacheRead;
      held.cacheWrite += e.cacheWrite5m + e.cacheWrite1h;
      held.cost += e.cost;
    }
  }

  const share = (a: number, b: number): number => (b === 0 ? 1 : a / b);
  const costCoverage = share(held.cost, billed.cost);
  const pass = compared > 0 && costCoverage >= COVERAGE_FLOOR;

  const kinds: Array<[string, number, number]> = [
    ['fresh input', held.input, billed.input],
    ['output', held.output, billed.output],
    ['cache read', held.cacheRead, billed.cacheRead],
    ['cache write', held.cacheWrite, billed.cacheWrite],
  ];

  return {
    name: 'COVERAGE',
    pass,
    lines: [
      `sessions compared: ${compared}`,
      `cost the transcripts account for: ${fmtUsd(held.cost)} of ${fmtUsd(billed.cost)} ` +
        `(${(costCoverage * 100).toFixed(2)}%, floor ${(COVERAGE_FLOOR * 100).toFixed(0)}%)`,
      ...kinds.map(
        ([label, h, b]) => `  ${label.padEnd(12)} ${(share(h, b) * 100).toFixed(2)}% of billed`,
      ),
      'Derived cost is a lower bound. Claude Code bills utility calls it never journals.',
    ],
  };
}

/**
 * A second opinion on the tool-call grain, read straight off the raw blocks rather than
 * through server/parse.ts, for the same reason independentRequestIdCount is: a check that
 * calls the parser can only restate it.
 */
async function independentToolCallCount(cutoff: number): Promise<{
  distinctIds: number;
  repeatedIds: number;
  idsPerRequest: Map<string, number>;
}> {
  const seen = new Set<string>();
  const idsPerRequest = new Map<string, number>();
  let repeatedIds = 0;

  for await (const { rec, requestId } of rawAssistantLines(cutoff)) {
    const content = (rec.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_use') continue;
      if (typeof block.id !== 'string' || typeof block.name !== 'string') continue;
      if (seen.has(block.id)) {
        repeatedIds++;
        continue;
      }
      seen.add(block.id);
      idsPerRequest.set(requestId, (idsPerRequest.get(requestId) ?? 0) + 1);
    }
  }

  return { distinctIds: seen.size, repeatedIds, idsPerRequest };
}

async function checkToolCalls(store: Store, cutoff: number): Promise<CheckResult> {
  const raw = await independentToolCallCount(cutoff);
  const stored = store.toolCallsSince(0);
  const storeCount = store.countToolCalls();
  const error = pct(storeCount, raw.distinctIds);

  const requestIds = new Set(store.eventsSince(0).map((e) => e.requestId));
  const orphans = stored.filter((c) => !requestIds.has(c.requestId));

  const dist = new Map<number, number>();
  for (const n of raw.idsPerRequest.values()) dist.set(n, (dist.get(n) ?? 0) + 1);
  const histogram = [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}:${c}`);

  const pass = raw.distinctIds > 0 && error <= 0.5 && orphans.length === 0;

  return {
    name: 'TOOLCALLS',
    pass,
    lines: [
      `independent distinct tool_use ids: ${raw.distinctIds}`,
      `raw ids seen more than once (session resume): ${raw.repeatedIds}`,
      `store countToolCalls(): ${storeCount}`,
      `error vs independent count: ${error.toFixed(3)}% (fail above 0.5%)`,
      `stored calls whose requestId is missing from events: ${orphans.length} (any is a failure)`,
      ...orphans.slice(0, 5).map((c) => `  ${c.id} -> ${c.requestId}`),
      `requests issuing tool calls: ${raw.idsPerRequest.size}`,
      `ids per request: ${histogram.join(', ')}`,
    ],
  };
}

/**
 * The per-skill cost number is a sum over every request a skill was live for, so it is only
 * meaningful if a request carries one skill. Claude Code writes the same request once per
 * content block, and nothing stops those copies from disagreeing, so prove they do not
 * rather than assume it: the store's insert-or-ignore upsert would silently keep whichever
 * copy landed first.
 */
async function checkAttribution(cutoff: number): Promise<CheckResult> {
  const perSkill = new Map<string, Set<string>>();
  const skillsByRequest = new Map<string, Set<string>>();
  const requests = new Set<string>();

  for await (const { rec, requestId } of rawAssistantLines(cutoff)) {
    requests.add(requestId);
    const skill = rec.attributionSkill;
    if (typeof skill !== 'string') continue;

    let values = skillsByRequest.get(requestId);
    if (values === undefined) skillsByRequest.set(requestId, (values = new Set()));
    values.add(skill);

    let ids = perSkill.get(skill);
    if (ids === undefined) perSkill.set(skill, (ids = new Set()));
    ids.add(requestId);
  }

  const conflicts = [...skillsByRequest].filter(([, values]) => values.size > 1);
  const coverage = requests.size === 0 ? 0 : skillsByRequest.size / requests.size;
  const top = [...perSkill.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 10);
  const pass = requests.size > 0 && conflicts.length === 0;

  return {
    name: 'ATTRIBUTION',
    pass,
    lines: [
      `requests with two distinct attributionSkill values: ${conflicts.length} (any is a failure)`,
      ...conflicts.slice(0, 5).map(([id, values]) => `  ${id}: ${[...values].join(' | ')}`),
      `skill-attributed requests: ${skillsByRequest.size} of ${requests.size} ` +
        `(${(coverage * 100).toFixed(1)}%), ${perSkill.size} distinct skills`,
      'top skills by request count:',
      ...top.map(([skill, ids]) => `  ${skill.padEnd(32)} ${ids.size}`),
    ],
  };
}

/**
 * Every raw user line inside the window, decoded but otherwise untouched. It exists for the
 * same reason rawAssistantLines does: a human-turn count that went through server/parse.ts
 * could only restate the parser, never catch it.
 */
async function* rawUserLines(
  cutoff: number,
): AsyncGenerator<{ rec: Record<string, unknown>; ts: number }> {
  for (const file of await walkJsonlFiles(TRANSCRIPTS_ROOT)) {
    try {
      if (statSync(file).mtimeMs < cutoff) continue;
    } catch {
      continue;
    }

    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const line of text.split('\n')) {
      if (!line.includes('"type":"user"')) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof raw !== 'object' || raw === null) continue;
      const rec = raw as Record<string, unknown>;
      if (rec.type !== 'user') continue;

      const ts = Date.parse(typeof rec.timestamp === 'string' ? rec.timestamp : '');
      if (Number.isNaN(ts) || ts < cutoff) continue;

      yield { rec, ts };
    }
  }
}

const TEAMMATE_MESSAGE_PREFIX = 'Another Claude session sent a message';

function userLineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/**
 * A second opinion on which user lines a person actually typed. Most of them are not: tool
 * results come back as user lines, subagent prompts carry isSidechain, injected context
 * carries isMeta, and a message from another Claude session is a user line too.
 *
 * A line with no `origin` field at all still counts, because slash commands, bash input and
 * every prompt from Claude Code before 2.1.186 carry none. That leniency is what makes the
 * teammate-prefix test load-bearing, so this counts the lines it rejects rather than
 * dropping them silently: if that number goes to zero the rule has stopped catching them.
 */
async function independentHumanTurnCount(cutoff: number): Promise<{
  turns: number;
  sessions: number;
  teammateLinesWithNoOrigin: number;
}> {
  const ids = new Set<string>();
  const sessions = new Set<string>();
  let teammateLinesWithNoOrigin = 0;

  for await (const { rec } of rawUserLines(cutoff)) {
    if (rec.isSidechain === true || rec.isMeta === true) continue;

    const message = rec.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (
      Array.isArray(content) &&
      (content as Array<Record<string, unknown>>).some((block) => block?.type === 'tool_result')
    ) {
      continue;
    }

    const origin = rec.origin as Record<string, unknown> | null | undefined;
    if (origin !== undefined && origin !== null) {
      if (origin.kind !== 'human') continue;
    } else if (userLineText(content).startsWith(TEAMMATE_MESSAGE_PREFIX)) {
      teammateLinesWithNoOrigin++;
      continue;
    }

    const id = rec.uuid;
    if (typeof id !== 'string' || id.length === 0) continue;
    ids.add(id);
    if (typeof rec.sessionId === 'string') sessions.add(rec.sessionId);
  }

  return { turns: ids.size, sessions: sessions.size, teammateLinesWithNoOrigin };
}

/**
 * Silence this long ends a run. The panel cuts on IDLE_CUT_MS in web/src/lib/select.ts; this
 * copy is restated rather than imported, so the validator stays a second opinion written
 * against the raw data instead of a mirror of the code it is checking.
 */
const IDLE_CUT_MS = 900_000;

/**
 * The share of inter-request gaps allowed to run past the cut.
 *
 * The longest run is only a readable number while the cut sits in the tail of the gap
 * distribution: a cut the body of the distribution crosses would be slicing work rather than
 * abandonment, and the answer would be an artefact of the constant. Working habits drift, so
 * this is asserted rather than assumed.
 */
const GAPS_OVER_CUT_LIMIT = 0.01;

async function checkRuns(store: Store, cutoff: number): Promise<CheckResult> {
  const raw = await independentHumanTurnCount(cutoff);
  // Windowed, not `countHumanTurns()`. Nothing calls `pruneBefore`, so the store keeps every
  // row it has ever ingested while this cutoff slides forward, and a whole-table count drifts
  // above a 30-day recount by however many rows have aged out. Turns are rare enough that a
  // handful of them is over 1% of the population, so that drift reads as a parser bug.
  const storeCount = store.humanTurnsSince(cutoff).length;
  const error = pct(storeCount, raw.turns);

  const timesBySession = new Map<string, number[]>();
  for (const e of store.eventsSince(cutoff)) {
    const list = timesBySession.get(e.sessionId);
    if (list === undefined) timesBySession.set(e.sessionId, [e.ts]);
    else list.push(e.ts);
  }

  const gaps: number[] = [];
  for (const times of timesBySession.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  }
  gaps.sort((a, b) => a - b);

  const minutes = (ms: number): string => (ms / 60_000).toFixed(2);
  const at = (p: number): number =>
    gaps.length === 0 ? 0 : gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))]!;
  const overCut = gaps.filter((g) => g > IDLE_CUT_MS).length;
  const share = gaps.length === 0 ? 1 : overCut / gaps.length;

  const turnSessions = new Set(store.humanTurnsSince(cutoff).map((t) => t.sessionId));
  const noTurn = [...timesBySession.keys()].filter((id) => !turnSessions.has(id));

  const pass = raw.turns > 0 && error <= 0.5 && gaps.length > 0 && share < GAPS_OVER_CUT_LIMIT;

  return {
    name: 'RUNS',
    pass,
    lines: [
      `independent human turns: ${raw.turns} across ${raw.sessions} sessions`,
      `store human turns in the same window: ${storeCount}`,
      `error vs independent count: ${error.toFixed(3)}% (fail above 0.5%)`,
      `teammate messages with no origin field, held out by the text check: ${raw.teammateLinesWithNoOrigin}`,
      `sessions with requests but no human turn: ${noTurn.length} of ${timesBySession.size}`,
      `inter-request gaps: ${gaps.length}, median ${minutes(at(0.5))} min, ` +
        `p99 ${minutes(at(0.99))} min, p99.5 ${minutes(at(0.995))} min`,
      `gaps past the ${IDLE_CUT_MS / 60_000}-minute cut: ${overCut} ` +
        `(${(share * 100).toFixed(3)}%, fail at or above ${(GAPS_OVER_CUT_LIMIT * 100).toFixed(0)}%)`,
    ],
  };
}

/**
 * Claude Code may be running on this machine while the validator runs, so a genuinely new
 * request can land between the two counts. Re-ingesting a request the store already held is
 * the real failure; an arrival stamped after the check began is not. The grace window covers
 * a response that completed during the check but carries a slightly earlier timestamp.
 */
const LIVE_ARRIVAL_GRACE_MS = 120_000;

async function checkIdempotency(store: Store): Promise<CheckResult> {
  const checkStartedAt = Date.now() - LIVE_ARRIVAL_GRACE_MS;
  const before = new Set(store.eventsSince(0).map((e) => e.requestId));
  const beforeCalls = new Set(store.toolCallsSince(0).map((c) => c.id));
  const scanner = createScanner({
    root: TRANSCRIPTS_ROOT,
    store,
    windowDays: WINDOW_DAYS,
    onEvents: () => {},
  });
  const reported = await scanner.backfill();
  const added = store.eventsSince(0).filter((e) => !before.has(e.requestId));
  const reingested = added.filter((e) => e.ts < checkStartedAt);
  const arrived = added.length - reingested.length;

  const addedCalls = store.toolCallsSince(0).filter((c) => !beforeCalls.has(c.id));
  const reingestedCalls = addedCalls.filter((c) => c.ts < checkStartedAt);
  const pass = reingested.length === 0 && reingestedCalls.length === 0;

  return {
    name: 'IDEMPOTENCY',
    pass,
    lines: [
      `events before rerun: ${before.size}, tool calls before rerun: ${beforeCalls.size}`,
      `second backfill reported: ${reported} new`,
      `genuinely new arrivals during the check: ${arrived} events, ` +
        `${addedCalls.length - reingestedCalls.length} tool calls`,
      `re-ingested pre-existing requests: ${reingested.length} (any is a failure)`,
      ...reingested.slice(0, 5).map((e) => `  ${e.requestId} ts ${new Date(e.ts).toISOString()}`),
      `re-ingested pre-existing tool calls: ${reingestedCalls.length} (any is a failure)`,
      ...reingestedCalls.slice(0, 5).map((c: ToolCall) => `  ${c.id} ts ${new Date(c.ts).toISOString()}`),
    ],
  };
}

function checkInvariants(store: Store, cutoff: number): CheckResult {
  const events = store.eventsSince(0);
  if (events.length === 0) {
    return { name: 'INVARIANTS', pass: false, lines: ['no events in store to check'] };
  }

  const lowerBound = cutoff - DAY_MS;
  const upperBound = Date.now() + 5 * 60_000;
  const seen = new Set<string>();
  const violations: string[] = [];

  for (const e of events) {
    if (e.thinking > e.output) {
      violations.push(`${e.requestId}: thinking (${e.thinking}) > output (${e.output})`);
    }

    const numericFields: [string, number][] = [
      ['input', e.input],
      ['output', e.output],
      ['thinking', e.thinking],
      ['cacheRead', e.cacheRead],
      ['cacheWrite5m', e.cacheWrite5m],
      ['cacheWrite1h', e.cacheWrite1h],
      ['webSearch', e.webSearch],
      ['webFetch', e.webFetch],
      ['cost', e.cost],
    ];
    for (const [field, value] of numericFields) {
      if (value < 0) violations.push(`${e.requestId}: negative ${field} (${value})`);
    }

    if (e.ts < lowerBound || e.ts > upperBound) {
      violations.push(`${e.requestId}: ts ${new Date(e.ts).toISOString()} outside the ${WINDOW_DAYS}-day window`);
    }

    if (e.requestId.length === 0) {
      violations.push(`(empty requestId) at ts ${e.ts}`);
    } else if (seen.has(e.requestId)) {
      violations.push(`${e.requestId}: duplicate requestId`);
    } else {
      seen.add(e.requestId);
    }
  }

  const pass = violations.length === 0;

  return {
    name: 'INVARIANTS',
    pass,
    lines: [
      `events checked: ${events.length}`,
      `violations: ${violations.length}`,
      ...violations.slice(0, 20),
      ...(violations.length > 20 ? [`... and ${violations.length - 20} more`] : []),
    ],
  };
}

function printResult(r: CheckResult): void {
  console.log(`\n[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
  for (const line of r.lines) console.log(`  ${line}`);
}

function printSummaryTable(results: CheckResult[]): void {
  console.log('\n--- validate.ts summary ---');
  const nameWidth = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${(r.pass ? 'PASS' : 'FAIL').padEnd(5)} ${r.name.padEnd(nameWidth)}  ${r.lines[0] ?? ''}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(failed.length === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed.length}/${results.length} checks FAILED.`);
}

async function main(): Promise<void> {
  const dbPath = parseArgs(process.argv.slice(2));

  if (!existsSync(dbPath)) {
    console.error(`FAIL: database not found at ${dbPath}. Run the backfill first.`);
    process.exitCode = 1;
    return;
  }

  const store = openStore(dbPath);
  try {
    if (store.countEvents() === 0) {
      console.error(`FAIL: database at ${dbPath} exists but has zero events. Nothing to validate.`);
      process.exitCode = 1;
      return;
    }

    const cutoff = Date.now() - WINDOW_DAYS * DAY_MS;

    const results: CheckResult[] = [];
    results.push(await checkDedupe(store, cutoff));
    results.push(checkInvariants(store, cutoff));
    results.push(await checkToolCalls(store, cutoff));
    results.push(await checkAttribution(cutoff));
    results.push(await checkRuns(store, cutoff));
    results.push(await checkPricing());
    results.push(await checkCoverage(store));
    results.push(await checkIdempotency(store));

    for (const r of results) printResult(r);
    printSummaryTable(results);

    process.exitCode = results.every((r) => r.pass) ? 0 : 1;
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  console.error('validate.ts crashed:', err);
  process.exitCode = 1;
});
