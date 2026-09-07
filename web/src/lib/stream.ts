import { useEffect, useState } from 'react';
import type { ServerMessage, SessionCost, UsageEvent } from '../../../shared/types.ts';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

export type LiveUsage = {
  events: UsageEvent[];
  sessionCosts: SessionCost[];
  serverNow: number;
  status: StreamStatus;
  backfilling: boolean;
  lastEventAt: number | null;
  eventCount: number;
};

type Published = Omit<LiveUsage, 'serverNow' | 'status'>;

type Accumulator = {
  events: UsageEvent[];
  seen: Set<string>;
  costs: Map<string, SessionCost>;
  backfilling: boolean;
};

function createAccumulator(): Accumulator {
  return { events: [], seen: new Set(), costs: new Map(), backfilling: false };
}

function insert(acc: Accumulator, event: UsageEvent): boolean {
  if (acc.seen.has(event.requestId)) return false;
  acc.seen.add(event.requestId);

  const last = acc.events[acc.events.length - 1];
  if (last === undefined || last.ts <= event.ts) {
    acc.events.push(event);
    return true;
  }

  let lo = 0;
  let hi = acc.events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (acc.events[mid]!.ts <= event.ts) lo = mid + 1;
    else hi = mid;
  }
  acc.events.splice(lo, 0, event);
  return true;
}

function accept(acc: Accumulator, msg: ServerMessage): boolean {
  switch (msg.type) {
    case 'snapshot': {
      acc.events = [];
      acc.seen.clear();
      acc.costs.clear();
      acc.backfilling = msg.backfilling;
      for (const event of msg.events) insert(acc, event);
      for (const cost of msg.sessionCosts) acc.costs.set(cost.sessionId, cost);
      return true;
    }
    case 'delta': {
      let changed = false;
      for (const event of msg.events) changed = insert(acc, event) || changed;
      for (const cost of msg.sessionCosts) {
        acc.costs.set(cost.sessionId, cost);
        changed = true;
      }
      return changed;
    }
    case 'backfill-done': {
      const changed = acc.backfilling;
      acc.backfilling = false;
      return changed;
    }
    case 'heartbeat':
      return false;
  }
}

function publish(acc: Accumulator): Published {
  const last = acc.events[acc.events.length - 1];
  return {
    events: acc.events.slice(),
    sessionCosts: [...acc.costs.values()],
    backfilling: acc.backfilling,
    lastEventAt: last === undefined ? null : last.ts,
    eventCount: acc.events.length,
  };
}

const STREAM_URL = '/api/events';
const COMMIT_MS = 100;
const CLOCK_MS = 1000;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 15_000;
const FAILURES_BEFORE_ERROR = 5;

/**
 * The hub beats every 15s. A proxy or a sleeping laptop can leave the socket
 * half-open, delivering no frames and no error, so silence past three beats is
 * the only evidence the stream is dead.
 */
const STALL_MS = 45_000;

export function useLiveUsage(): LiveUsage {
  const [usage, setUsage] = useState<LiveUsage>(() => ({
    ...publish(createAccumulator()),
    serverNow: Date.now(),
    status: 'connecting',
  }));

  useEffect(() => {
    const acc = createAccumulator();
    let source: EventSource | null = null;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let anchorServer = Date.now();
    let anchorLocal = performance.now();
    let lastFrame = performance.now();
    let stopped = false;

    const clock = () => Math.round(anchorServer + (performance.now() - anchorLocal));

    const setStatus = (status: StreamStatus) => {
      setUsage((prev) => (prev.status === status ? prev : { ...prev, status }));
    };

    const degrade = () => {
      setStatus(failures >= FAILURES_BEFORE_ERROR ? 'error' : 'reconnecting');
    };

    const commit = () => {
      commitTimer = null;
      setUsage((prev) => ({ ...publish(acc), serverNow: clock(), status: prev.status }));
    };

    const handle = (frame: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(frame.data));
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== 'object') return;
      const msg = parsed as ServerMessage;

      lastFrame = performance.now();
      if (typeof msg.serverNow === 'number') {
        anchorServer = msg.serverNow;
        anchorLocal = performance.now();
      }
      failures = 0;
      setStatus('live');
      if (accept(acc, msg) && commitTimer === null) commitTimer = setTimeout(commit, COMMIT_MS);
    };

    const reconnect = () => {
      if (source !== null) {
        source.close();
        source = null;
      }
      if (retryTimer !== null) return;
      failures += 1;
      degrade();
      const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (failures - 1));
      retryTimer = setTimeout(connect, backoff * (0.5 + Math.random() * 0.5));
    };

    const connect = () => {
      retryTimer = null;
      lastFrame = performance.now();
      source = new EventSource(STREAM_URL);
      source.onmessage = handle;
      source.onerror = () => {
        if (stopped) return;
        if (source !== null && source.readyState === EventSource.CLOSED) {
          reconnect();
          return;
        }
        failures += 1;
        degrade();
      };
    };

    connect();

    const clockTimer = setInterval(() => {
      if (source !== null && performance.now() - lastFrame > STALL_MS) reconnect();
      setUsage((prev) => {
        const now = clock();
        return now === prev.serverNow ? prev : { ...prev, serverNow: now };
      });
    }, CLOCK_MS);

    return () => {
      stopped = true;
      clearInterval(clockTimer);
      if (commitTimer !== null) clearTimeout(commitTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (source !== null) {
        source.close();
        source = null;
      }
    };
  }, []);

  return usage;
}
