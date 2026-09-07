import { useMemo, useState } from 'react';
import type { UsageEvent } from '../../../shared/types.ts';
import { useFilters, type Filters } from '../lib/filters.tsx';
import {
  colorForEffort,
  colorForModel,
  effortLabel,
  formatCompact,
  formatCost,
  formatCount,
  formatDateTime,
  formatRelative,
  modelLabel,
} from '../lib/format.ts';
import { applyFilters, recentFeed, totals } from '../lib/select.ts';

export type FeedProps = {
  events: readonly UsageEvent[];
  serverNow: number;
};

const CAP = 100;

const FEED_CSS = `
@keyframes feed-arrive {
  from { background: var(--accent-soft); }
  to { background: transparent; }
}
.feed-new > td { animation: feed-arrive 900ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  .feed-new > td { animation: none; }
}
`;

const controlStyle = {
  background: 'none',
  border: '1px solid var(--border-strong)',
  borderRadius: 999,
  padding: '2px 10px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  color: 'var(--text-secondary)',
};

const cellNowrap = { whiteSpace: 'nowrap' } as const;
const inlineSwatch = { display: 'inline-flex', alignItems: 'center', gap: 6 } as const;

/**
 * Rows that arrived after this baseline keep the class for as long as they are
 * listed, so a re-render from the one-second clock tick cannot cut the animation
 * short by dropping the class mid-flight.
 */
type Baseline = { filters: Filters; ids: Set<string> };

function baselineOf(filters: Filters, events: readonly UsageEvent[]): Baseline {
  return { filters, ids: new Set(events.map((e) => e.requestId)) };
}

export function Feed({ events, serverNow }: FeedProps) {
  const { filters, reset, isDefault } = useFilters();
  const [frozen, setFrozen] = useState<readonly UsageEvent[] | null>(null);

  const visible = useMemo(() => applyFilters(events, filters), [events, filters]);
  const live = useMemo(() => recentFeed(visible, CAP), [visible]);
  const shown = frozen ?? live;

  const [baseline, setBaseline] = useState<Baseline>(() => baselineOf(filters, live));
  const stale = baseline.filters !== filters || (baseline.ids.size === 0 && live.length > 0);
  if (stale) setBaseline(baselineOf(filters, live));
  const known = stale ? null : baseline.ids;

  const held = useMemo(() => {
    if (frozen === null) return 0;
    const listed = new Set(frozen.map((e) => e.requestId));
    return live.reduce((n, e) => (listed.has(e.requestId) ? n : n + 1), 0);
  }, [frozen, live]);

  const rows = useMemo(
    () => shown.map((event) => ({ event, tokens: totals([event]).totalTokens })),
    [shown],
  );

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <style>{FEED_CSS}</style>
      <div className="card-header">
        <h2>Live feed</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
          {frozen === null ? null : (
            <span className="pill pill-warning">
              paused{held > 0 ? ` · ${formatCount(held)} new waiting` : ''}
            </span>
          )}
          <button
            type="button"
            onClick={() => setFrozen(frozen === null ? live : null)}
            style={controlStyle}
            aria-pressed={frozen !== null}
          >
            {frozen === null ? 'Pause' : 'Resume'}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: 'var(--sp-5) 0', maxWidth: 460 }}>
          <p style={{ margin: '0 0 var(--sp-3)' }} className="secondary">
            {isDefault
              ? 'No requests recorded yet. Rows appear here the moment Claude Code makes a call.'
              : 'No request matches the current filters.'}
          </p>
          {isDefault ? null : (
            <button
              type="button"
              onClick={reset}
              className="pill pill-accent"
              style={{ cursor: 'pointer', padding: '4px 12px' }}
            >
              Reset filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="table-scroll" style={{ maxHeight: 520 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Model</th>
                  <th>Project</th>
                  <th>Effort</th>
                  <th>Agent</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ event, tokens }) => (
                  <tr
                    key={event.requestId}
                    className={known !== null && !known.has(event.requestId) ? 'feed-new' : undefined}
                  >
                    <td style={cellNowrap} title={formatDateTime(event.ts)}>
                      {formatRelative(event.ts, serverNow)}
                    </td>
                    <td style={cellNowrap}>
                      <span style={inlineSwatch}>
                        <span className="swatch" style={{ background: colorForModel(event.model) }} />
                        {modelLabel(event.model)}
                      </span>
                    </td>
                    <td style={cellNowrap}>{event.project}</td>
                    <td style={cellNowrap}>
                      {event.effort === null ? (
                        <span className="muted">–</span>
                      ) : (
                        <span style={inlineSwatch}>
                          <span className="swatch" style={{ background: colorForEffort(event.effort) }} />
                          {effortLabel(event.effort)}
                        </span>
                      )}
                    </td>
                    <td style={cellNowrap}>
                      {event.isSidechain ? (
                        <span className="pill pill-accent">sub · {event.attributionAgent ?? 'untagged'}</span>
                      ) : (
                        <span className="pill">main</span>
                      )}
                    </td>
                    <td className="num">{formatCompact(tokens)}</td>
                    <td className="num">{formatCost(event.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ margin: 'var(--sp-3) 0 0', fontSize: 12 }}>
            Newest {formatCount(rows.length)} of {formatCount(visible.length)} requests in view. The
            cap trims this list only; every total elsewhere counts all of them.
          </p>
        </>
      )}
    </section>
  );
}
