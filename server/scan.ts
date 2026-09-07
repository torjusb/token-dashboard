import { watch as fsWatch, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { FSWatcher } from 'node:fs';
import type { SessionCost, ToolCall, UsageEvent } from '../shared/types.ts';
import { parseLine } from './parse.ts';
import { costOf } from './pricing.ts';
import type { Store } from './store.ts';
import { tailFile } from './tail.ts';

const DAY_MS = 86_400_000;
const FILE_CONCURRENCY = 8;
const DEBOUNCE_MS = 250;
const RESCAN_MS = 5 * 60_000;
const PROGRESS_EVERY = 100;

export type ScanOptions = {
  root: string;
  store: Store;
  windowDays: number;
  onEvents: (events: UsageEvent[], costs: SessionCost[], toolCalls: ToolCall[]) => void;
};

export type Scanner = {
  backfill(): Promise<number>;
  watch(): () => void;
  stop(): void;
};

type SweepStats = {
  filesSeen: number;
  filesSkippedByMtime: number;
  events: number;
  sessionCosts: number;
  toolCalls: number;
  elapsedMs: number;
};

async function listTranscripts(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });

    // isFile() excludes symlinks, which is load-bearing rather than incidental: one subagent
    // transcript is reachable both at its real path and through a symlink left by the session
    // that spawned it, so following symlinks would read the same 26 requests and 78 tool calls
    // twice under two different paths.
    const paths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(entry.parentPath, entry.name));

    // Resuming a session copies the earlier requests into the new session's transcript, so
    // about 1% of requestIds appear in two files under two different sessionIds. The
    // requestId primary key keeps the totals correct, but whichever file is read first wins
    // the attribution. Oldest-first makes that deterministic across rebuilds and hands the
    // requests to the session that actually made them rather than to the resume.
    return paths.sort((a, b) => lastModified(a) - lastModified(b) || a.localeCompare(b));
  } catch (err) {
    console.error(`[scan] cannot list ${root}:`, err);
    return [];
  }
}

function lastModified(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function createScanner(opts: ScanOptions): Scanner {
  const pending = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let rescan: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  }

  function windowStart(): number {
    return Date.now() - opts.windowDays * DAY_MS;
  }

  function emit(events: UsageEvent[], costs: SessionCost[], toolCalls: ToolCall[]): void {
    if (events.length === 0 && costs.length === 0 && toolCalls.length === 0) return;
    opts.onEvents(events, costs, toolCalls);
  }

  function ingest(
    filePath: string,
    cutoff: number,
  ): { events: UsageEvent[]; costs: SessionCost[]; toolCalls: ToolCall[] } {
    const prev = opts.store.getOffset(filePath);
    const tail = tailFile(filePath, prev);

    const events: UsageEvent[] = [];
    const costs: SessionCost[] = [];
    const toolCalls: ToolCall[] = [];
    for (const line of tail.lines) {
      const parsed = parseLine(line, filePath);
      if (parsed === null) continue;
      if (parsed.kind === 'cost') {
        costs.push(parsed.cost);
      } else if (parsed.event.ts >= cutoff) {
        events.push({ ...parsed.event, cost: costOf(parsed.event) });
        toolCalls.push(...parsed.toolCalls);
      }
    }

    const newEvents = opts.store.upsertEvents(events);
    const newCosts = opts.store.upsertSessionCosts(costs);
    const newToolCalls = opts.store.upsertToolCalls(toolCalls);

    // Offset advances only after the rows are committed, so a crash mid-file replays
    // those lines rather than losing them; the requestId primary key absorbs the replay.
    const moved =
      prev === null ||
      tail.offset !== prev.offset ||
      tail.size !== prev.size ||
      tail.mtimeMs !== prev.mtimeMs;
    if (moved) opts.store.setOffset(filePath, tail.offset, tail.size, tail.mtimeMs);

    return { events: newEvents, costs: newCosts, toolCalls: newToolCalls };
  }

  async function sweep(
    progress: ((done: number, total: number, events: number) => void) | null,
  ): Promise<SweepStats> {
    const startedAt = Date.now();
    const cutoff = windowStart();
    const files = await listTranscripts(opts.root);

    const live: string[] = [];
    let filesSkippedByMtime = 0;
    for (const filePath of files) {
      if (lastModified(filePath) < cutoff) filesSkippedByMtime++;
      else live.push(filePath);
    }

    let cursor = 0;
    let done = 0;
    let events = 0;
    let sessionCosts = 0;
    let toolCalls = 0;

    async function worker(): Promise<void> {
      while (cursor < live.length && !stopped) {
        const filePath = live[cursor];
        cursor += 1;
        if (filePath === undefined) return;
        try {
          const fresh = ingest(filePath, cutoff);
          events += fresh.events.length;
          sessionCosts += fresh.costs.length;
          toolCalls += fresh.toolCalls.length;
          emit(fresh.events, fresh.costs, fresh.toolCalls);
        } catch (err) {
          console.error(`[scan] ${filePath}:`, err);
        }
        done += 1;
        if (progress !== null && done % PROGRESS_EVERY === 0) progress(done, live.length, events);
        await yieldToLoop();
      }
    }

    const workers = Array.from({ length: Math.min(FILE_CONCURRENCY, live.length) }, worker);
    await Promise.all(workers);

    return {
      filesSeen: files.length,
      filesSkippedByMtime,
      events,
      sessionCosts,
      toolCalls,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function drainPending(): Promise<void> {
    const cutoff = windowStart();
    while (pending.size > 0 && !stopped) {
      const batch = [...pending];
      pending.clear();
      for (const filePath of batch) {
        if (stopped) return;
        try {
          const fresh = ingest(filePath, cutoff);
          emit(fresh.events, fresh.costs, fresh.toolCalls);
        } catch (err) {
          console.error(`[scan] ${filePath}:`, err);
        }
        await yieldToLoop();
      }
    }
  }

  // Fixed delay from the first change of a burst, never reset by later ones, so a
  // continuously appending session cannot postpone its own drain indefinitely.
  function scheduleDrain(): void {
    if (stopped || debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      void serialize(drainPending);
    }, DEBOUNCE_MS);
  }

  function stop(): void {
    stopped = true;
    if (debounce !== null) {
      clearTimeout(debounce);
      debounce = null;
    }
    if (rescan !== null) {
      clearInterval(rescan);
      rescan = null;
    }
    if (watcher !== null) {
      watcher.close();
      watcher = null;
    }
    pending.clear();
  }

  return {
    backfill(): Promise<number> {
      return serialize(async () => {
        const stats = await sweep((done, total, events) => {
          console.log(`[scan] backfill ${done}/${total} files, ${events} events`);
        });
        console.log(
          `[scan] backfill: ${stats.filesSeen} files seen, ${stats.filesSkippedByMtime} skipped by mtime, ` +
            `${stats.events} events, ${stats.toolCalls} tool calls, ${stats.sessionCosts} session costs, ` +
            `${(stats.elapsedMs / 1000).toFixed(1)}s`,
        );
        return stats.events;
      });
    },

    watch(): () => void {
      if (watcher !== null) return stop;
      stopped = false;

      watcher = fsWatch(opts.root, { recursive: true }, (_type, name) => {
        if (typeof name !== 'string' || !name.endsWith('.jsonl')) return;
        pending.add(join(opts.root, name));
        scheduleDrain();
      });
      watcher.on('error', (err) => {
        console.error('[scan] watch error:', err);
      });

      rescan = setInterval(() => {
        void serialize(async () => {
          const stats = await sweep(null);
          if (stats.events > 0 || stats.sessionCosts > 0 || stats.toolCalls > 0) {
            console.log(
              `[scan] rescan: ${stats.events} events, ${stats.toolCalls} tool calls, ` +
                `${stats.sessionCosts} session costs`,
            );
          }
        });
      }, RESCAN_MS);
      rescan.unref();

      return stop;
    },

    stop,
  };
}
