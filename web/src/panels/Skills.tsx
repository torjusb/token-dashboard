import { useMemo } from 'react';
import type { ToolCall, UsageEvent } from '../../../shared/types.ts';
import { BarChart, logScale } from '../charts/index.ts';
import type { BarDatum } from '../charts/index.ts';
import {
  formatCompact,
  formatCost,
  formatCostCompact,
  formatCount,
  formatPercent,
} from '../lib/format.ts';
import {
  NO_PLUGIN,
  NO_SKILL,
  byMcpServer,
  byPlugin,
  bySkill,
  byTool,
  toolMix,
  totals,
} from '../lib/select.ts';
import type { ToolTotals } from '../lib/select.ts';

export type SkillsProps = {
  events: readonly UsageEvent[];
  toolCalls: readonly ToolCall[];
  loading?: boolean;
};

const OTHER = '__other__';

const SKILL_BAR_TOP = 12;
const SKILL_SPLIT_TOP = 8;
const PLUGIN_TOP = 8;
const TOOL_TOP = 14;
const MCP_TOP = 8;

const NOMINAL = 'var(--series-1)';
const SUB_HUE = 'var(--series-2)';
const MCP_HUE = 'var(--series-3)';
const PLUGIN_HUE = 'var(--series-4)';
const TAIL_HUE = 'var(--series-other)';

const NOTE_STYLE = { fontSize: 11, margin: 'var(--sp-3) 0 0' } as const;

function CardHead({ title, total, note }: { title: string; total: string; note?: string }) {
  return (
    <div className="card-header">
      <div>
        <h2>{title}</h2>
        {note === undefined ? null : (
          <div className="muted" style={{ fontSize: 11 }}>
            {note}
          </div>
        )}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {total}
      </div>
    </div>
  );
}

function SplitBar({ left, right, label }: { left: number; right: number; label: string }) {
  const whole = left + right;
  return (
    <div role="img" aria-label={label} style={{ display: 'flex', gap: 2, height: 10 }}>
      {whole > 0 ? (
        <>
          <div
            style={{
              flexGrow: left,
              background: NOMINAL,
              borderRadius: '3px 0 0 3px',
              minWidth: left > 0 ? 2 : 0,
            }}
          />
          <div
            style={{
              flexGrow: right,
              background: SUB_HUE,
              borderRadius: '0 3px 3px 0',
              minWidth: right > 0 ? 2 : 0,
            }}
          />
        </>
      ) : (
        <div style={{ flexGrow: 1, background: 'var(--chart-grid)', borderRadius: 3 }} />
      )}
    </div>
  );
}

function Meter({ fill, color, filled }: { fill: number; color: string; filled: boolean }) {
  const pct = Number.isFinite(fill) ? Math.max(0, Math.min(1, fill)) : 0;
  return (
    <div
      aria-hidden="true"
      style={{
        height: 6,
        borderRadius: 3,
        background: 'var(--chart-grid)',
        overflow: 'hidden',
        minWidth: 40,
      }}
    >
      <div
        style={{
          width: `${pct * 100}%`,
          height: '100%',
          borderRadius: 3,
          background: color,
          minWidth: filled ? 2 : 0,
        }}
      />
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function tailLabel(count: number, top: number, noun: string): string {
  const rest = Math.max(count - top, 0);
  return `Other (${formatCount(rest)} ${noun}${rest === 1 ? '' : 's'})`;
}

/**
 * Bash alone is two thirds of every call, so a linear bar leaves the rest of the tail at
 * sub-pixel width. The meter is a log axis with the exact counts in the next column.
 */
function CallTable({
  rows,
  noun,
  color,
  emptyMessage,
}: {
  rows: ReadonlyArray<{ key: string; label: string; share: number; muted: boolean } & ToolTotals>;
  noun: string;
  color: string;
  emptyMessage: string;
}) {
  const peak = rows.reduce((into, row) => Math.max(into, row.calls), 0);
  const scale = logScale([1, Math.max(peak, 10)], [0, 1]);

  if (rows.length === 0) {
    return <div className="muted">{emptyMessage}</div>;
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>{noun}</th>
            <th style={{ width: '22%' }}>Calls (log)</th>
            <th className="num">Calls</th>
            <th className="num">Share</th>
            <th className="num">Requests</th>
            <th className="num">Request cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td className={row.muted ? 'muted' : undefined} style={{ maxWidth: 260 }}>
                <span className="mono">{row.label}</span>
              </td>
              <td>
                <Meter
                  fill={row.calls > 0 ? scale.to(row.calls) : 0}
                  color={row.muted ? TAIL_HUE : color}
                  filled={row.calls > 0}
                />
              </td>
              <td className="num">{formatCount(row.calls)}</td>
              <td className="num muted">{formatPercent(row.share, row.share < 0.1 ? 1 : 0)}</td>
              <td className="num">{formatCount(row.requests)}</td>
              <td className="num">{formatCost(row.requestCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyPanel({ loading }: { loading: boolean }) {
  return (
    <section>
      <div className="card" style={{ display: 'grid', placeItems: 'center', minHeight: 220 }}>
        <div style={{ textAlign: 'center', maxWidth: 380 }}>
          <h2>{loading ? 'Reading 30 days of transcripts' : 'Nothing to attribute'}</h2>
          <p className="secondary">
            {loading
              ? 'Backfill is still running. Skills and tools appear as soon as the first requests land.'
              : 'No request in the current filter range. Widen the date range, or clear the project, model, skill and agent filters.'}
          </p>
        </div>
      </div>
    </section>
  );
}

export function Skills({ events, toolCalls, loading = false }: SkillsProps) {
  const ranked = useMemo(() => {
    const rows = bySkill(events);
    const attributed = rows
      .filter((row) => row.key !== NO_SKILL)
      .sort((a, b) => b.cost - a.cost);
    const unattributed = rows.find((row) => row.key === NO_SKILL);
    let cost = 0;
    let requests = 0;
    let tokens = 0;
    for (const row of attributed) {
      cost += row.cost;
      requests += row.requests;
      tokens += row.totalTokens;
    }
    return {
      rows: attributed,
      cost,
      requests,
      tokens,
      noSkillCost: unattributed?.cost ?? 0,
      noSkillRequests: unattributed?.requests ?? 0,
      noSkillTokens: unattributed?.totalTokens ?? 0,
    };
  }, [events]);

  const skillBars = useMemo<BarDatum[]>(() => {
    const head = ranked.rows.slice(0, SKILL_BAR_TOP).map((row) => ({
      key: String(row.key),
      label: String(row.key),
      value: row.cost,
      color: NOMINAL,
    }));
    const rest = ranked.rows.slice(SKILL_BAR_TOP);
    if (rest.length === 0) return head;
    return [
      ...head,
      {
        key: OTHER,
        label: tailLabel(ranked.rows.length, SKILL_BAR_TOP, 'skill'),
        value: rest.reduce((into, row) => into + row.cost, 0),
        color: TAIL_HUE,
      },
    ];
  }, [ranked]);

  const split = useMemo(() => {
    const skilled = events.filter((event) => event.attributionSkill !== null);
    const mainEvents = skilled.filter((event) => !event.isSidechain);
    const subEvents = skilled.filter((event) => event.isSidechain);
    const main = totals(mainEvents);
    const sub = totals(subEvents);
    const byKey = (scoped: readonly UsageEvent[]) =>
      new Map(bySkill(scoped).map((row) => [String(row.key), row] as const));
    const mainRows = byKey(mainEvents);
    const subRows = byKey(subEvents);
    const rows = ranked.rows.slice(0, SKILL_SPLIT_TOP).map((row) => {
      const name = String(row.key);
      const sub = subRows.get(name);
      return {
        name,
        main: mainRows.get(name)?.cost ?? 0,
        sub: sub?.cost ?? 0,
        cost: row.cost,
        subRequests: sub?.requests ?? 0,
        requests: row.requests,
      };
    });
    const whole = main.cost + sub.cost;
    return { main, sub, rows, subShare: whole > 0 ? sub.cost / whole : 0, whole };
  }, [events, ranked]);

  const plugins = useMemo(() => {
    const rows = byPlugin(events);
    const attributed = rows.filter((row) => row.key !== NO_PLUGIN).sort((a, b) => b.cost - a.cost);
    const bars: BarDatum[] = attributed.slice(0, PLUGIN_TOP).map((row) => ({
      key: String(row.key),
      label: String(row.key),
      value: row.cost,
      color: PLUGIN_HUE,
    }));
    const rest = attributed.slice(PLUGIN_TOP);
    if (rest.length > 0) {
      bars.push({
        key: OTHER,
        label: tailLabel(attributed.length, PLUGIN_TOP, 'plugin'),
        value: rest.reduce((into, row) => into + row.cost, 0),
        color: TAIL_HUE,
      });
    }
    let cost = 0;
    for (const row of attributed) cost += row.cost;
    return { bars, cost, count: attributed.length };
  }, [events]);

  const mix = useMemo(() => toolMix(toolCalls, events), [toolCalls, events]);

  const toolRows = useMemo(
    () =>
      byTool(toolCalls, events, { top: TOOL_TOP }).map((row) => ({
        ...row,
        key: String(row.key),
        label: row.key === OTHER ? tailLabel(mix.tools, TOOL_TOP, 'tool') : String(row.key),
        muted: row.key === OTHER,
      })),
    [toolCalls, events, mix],
  );

  const mcpRows = useMemo(
    () =>
      byMcpServer(toolCalls, events, { top: MCP_TOP }).map((row) => ({
        ...row,
        key: String(row.key),
        label: row.key === OTHER ? tailLabel(mix.mcpServers, MCP_TOP, 'server') : String(row.key),
        muted: row.key === OTHER,
      })),
    [toolCalls, events, mix],
  );

  if (events.length === 0) return <EmptyPanel loading={loading} />;

  const attributedShare = events.length > 0 ? ranked.requests / events.length : 0;

  return (
    <section>
      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <h1>Skills and tools</h1>
        <div className="muted" style={{ fontSize: 12 }}>
          {`${formatCount(ranked.requests)} of ${formatCount(events.length)} requests ran with a skill loaded, across ${plural(ranked.rows.length, 'skill')}`}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div className="card">
          <CardHead
            title="Skills by cost"
            total={formatCost(ranked.cost)}
            note="Every request the skill was loaded for, subagents included"
          />

          <div className="grid-tiles" style={{ marginBottom: 'var(--sp-4)' }}>
            <div className="tile">
              <span className="tile-label">With a skill</span>
              <span className="tile-value">{formatCost(ranked.cost)}</span>
              <span className="tile-delta">
                {`${formatCount(ranked.requests)} requests, ${formatCompact(ranked.tokens)} tokens, ${formatPercent(attributedShare, 1)} of all`}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">No skill loaded</span>
              <span className="tile-value">{formatCost(ranked.noSkillCost)}</span>
              <span className="tile-delta">
                {`${formatCount(ranked.noSkillRequests)} requests, ${formatCompact(ranked.noSkillTokens)} tokens`}
              </span>
            </div>
            <div className="tile">
              <span className="tile-label">Priciest skill</span>
              <span className="tile-value">{formatCost(ranked.rows[0]?.cost ?? 0)}</span>
              <span className="tile-delta">{String(ranked.rows[0]?.key ?? 'none in range')}</span>
            </div>
          </div>

          <BarChart
            data={skillBars}
            formatValue={formatCostCompact}
            ariaLabel="Skills ranked by the cost of the requests they were loaded for"
            emptyMessage="No request in range carries a skill"
          />

          {ranked.rows.length === 0 ? null : (
            <div className="table-scroll" style={{ marginTop: 'var(--sp-4)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th className="num">Cost</th>
                    <th className="num">Share</th>
                    <th className="num">Tokens</th>
                    <th className="num">Requests</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.rows.map((row) => {
                    const share = ranked.cost > 0 ? row.cost / ranked.cost : 0;
                    return (
                    <tr key={String(row.key)}>
                      <td style={{ maxWidth: 280 }}>
                        <span className="mono">{String(row.key)}</span>
                      </td>
                      <td className="num">{formatCost(row.cost)}</td>
                      <td className="num muted">{formatPercent(share, share < 0.1 ? 1 : 0)}</td>
                      <td className="num">{formatCompact(row.totalTokens)}</td>
                      <td className="num">{formatCount(row.requests)}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="muted" style={NOTE_STYLE}>
            {ranked.noSkillRequests === 0
              ? 'Share is of skill-attributed cost. Every request in view has a skill loaded, so it is also the share of everything.'
              : `Share is of skill-attributed cost, not of everything. The ${formatCount(ranked.noSkillRequests)} requests with no skill loaded cost ${formatCost(ranked.noSkillCost)} and sit outside this ranking.`}
          </p>
        </div>

        <div className="card">
          <CardHead
            title="Main thread vs subagents"
            total={formatCost(split.whole)}
            note={`Subagents are ${formatPercent(split.subShare, 1)} of what skills cost`}
          />

          <div className="grid-tiles" style={{ marginBottom: 'var(--sp-3)' }}>
            <div className="tile">
              <span className="tile-label">
                <span className="swatch" style={{ background: NOMINAL, marginRight: 6 }} />
                Main thread
              </span>
              <span className="tile-value">{formatCost(split.main.cost)}</span>
              <span className="tile-delta">{`${formatCount(split.main.requests)} requests`}</span>
            </div>
            <div className="tile">
              <span className="tile-label">
                <span className="swatch" style={{ background: SUB_HUE, marginRight: 6 }} />
                Subagents
              </span>
              <span className="tile-value">{formatCost(split.sub.cost)}</span>
              <span className="tile-delta">{`${formatCount(split.sub.requests)} requests`}</span>
            </div>
          </div>

          <SplitBar
            left={split.main.cost}
            right={split.sub.cost}
            label={`Main thread ${formatCost(split.main.cost)}, subagents ${formatCost(split.sub.cost)}`}
          />

          <div className="table-scroll" style={{ marginTop: 'var(--sp-4)' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th style={{ width: '26%' }}>Split</th>
                  <th className="num">Main</th>
                  <th className="num">Subagents</th>
                  <th className="num">Sub of cost</th>
                  <th className="num">Sub of requests</th>
                </tr>
              </thead>
              <tbody>
                {split.rows.map((row) => (
                  <tr key={row.name}>
                    <td style={{ maxWidth: 240 }}>
                      <span className="mono">{row.name}</span>
                    </td>
                    <td>
                      <SplitBar
                        left={row.main}
                        right={row.sub}
                        label={`${row.name}: main ${formatCost(row.main)}, subagents ${formatCost(row.sub)}`}
                      />
                    </td>
                    <td className="num">{formatCost(row.main)}</td>
                    <td className="num">{formatCost(row.sub)}</td>
                    <td className="num muted">
                      {formatPercent(row.cost > 0 ? row.sub / row.cost : 0, 0)}
                    </td>
                    <td className="num muted">
                      {formatPercent(row.requests > 0 ? row.subRequests / row.requests : 0, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted" style={NOTE_STYLE}>
            A skill that fans out subagents keeps spending after the turn that invoked it. The
            subagent requests carry the skill attribution too, so this is the same money as the
            ranking above, cut by where it was spent. The two share columns disagree on purpose:
            subagent requests are usually cheaper than the main-thread turns that dispatch them,
            so a skill can be half its requests and a third of its cost.
          </p>
        </div>

        <div className="card">
          <CardHead
            title="Plugins by cost"
            total={formatCost(plugins.cost)}
            note={`${plural(plugins.count, 'plugin')}. A plugin agent produces requests with no skill attached, so this is not the skill ranking rolled up.`}
          />
          <BarChart
            data={plugins.bars}
            formatValue={formatCostCompact}
            ariaLabel="Plugins ranked by the cost of the requests they were loaded for"
            emptyMessage="No request in range carries a plugin"
          />
        </div>

        <div className="card">
          <CardHead
            title="Tools by calls"
            total={formatCount(mix.calls)}
            note={`${formatCount(mix.tools)} distinct tools across ${formatCount(mix.requests)} requests`}
          />
          <CallTable
            rows={toolRows}
            noun="Tool"
            color={NOMINAL}
            emptyMessage={
              toolCalls.length === 0
                ? 'The stream has delivered no tool calls.'
                : 'No tool call belongs to a request in this filter range.'
            }
          />
          <p className="muted" style={NOTE_STYLE}>
            Request cost is the cost of the requests that made these calls, not the cost of the
            tool, which has none of its own. A request calling three tools lands its full cost in
            three rows, so that column sums past the filtered total and its shares past 100%.
            Calls and share are of the tool grain and do add up.
          </p>
        </div>

        <div className="card">
          <CardHead
            title="MCP servers by calls"
            total={formatCount(mix.mcpCalls)}
            note={`${formatCount(mix.mcpServers)} servers, ${formatPercent(mix.calls > 0 ? mix.mcpCalls / mix.calls : 0, 1)} of all tool calls`}
          />
          <CallTable
            rows={mcpRows}
            noun="Server"
            color={MCP_HUE}
            emptyMessage={
              toolCalls.length === 0
                ? 'The stream has delivered no tool calls.'
                : 'No MCP call belongs to a request in this filter range.'
            }
          />
          <p className="muted" style={NOTE_STYLE}>
            Read off the <span className="mono">mcp__server__tool</span> call name. Share is of
            MCP calls only, so these rows sum to 100% of the MCP slice rather than of every tool
            call. Request cost is non-additive here for the same reason as the tool table.
          </p>
        </div>
      </div>
    </section>
  );
}
