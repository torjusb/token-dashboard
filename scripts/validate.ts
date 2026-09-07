import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { UsageEvent } from '../shared/types.ts';
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
 * A second opinion on the dedupe key, written from scratch against the raw
 * transcript format rather than calling server/parse.ts, so check 1 actually
 * catches a parse.ts bug instead of restating it.
 */
async function independentRequestIdCount(
  cutoff: number,
): Promise<{ rawLines: number; distinctIds: number }> {
  const files = await walkJsonlFiles(TRANSCRIPTS_ROOT);
  let rawLines = 0;
  const ids = new Set<string>();

  for (const file of files) {
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

      rawLines++;
      ids.add(requestId);
    }
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
 * Claude Code may be running on this machine while the validator runs, so a genuinely new
 * request can land between the two counts. Re-ingesting a request the store already held is
 * the real failure; an arrival stamped after the check began is not. The grace window covers
 * a response that completed during the check but carries a slightly earlier timestamp.
 */
const LIVE_ARRIVAL_GRACE_MS = 120_000;

async function checkIdempotency(store: Store): Promise<CheckResult> {
  const checkStartedAt = Date.now() - LIVE_ARRIVAL_GRACE_MS;
  const before = new Set(store.eventsSince(0).map((e) => e.requestId));
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
  const pass = reingested.length === 0;

  return {
    name: 'IDEMPOTENCY',
    pass,
    lines: [
      `events before rerun: ${before.size}`,
      `second backfill reported: ${reported} new`,
      `genuinely new arrivals during the check: ${arrived}`,
      `re-ingested pre-existing requests: ${reingested.length} (any is a failure)`,
      ...reingested.slice(0, 5).map((e) => `  ${e.requestId} ts ${new Date(e.ts).toISOString()}`),
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
