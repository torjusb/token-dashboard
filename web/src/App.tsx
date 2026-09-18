import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { HumanTurn, SessionCost, ToolCall, UsageEvent } from '../../shared/types.ts';
import { FiltersProvider, useFilters } from './lib/filters.tsx';
import type { AgentScope } from './lib/filters.tsx';
import { applyFilters, distinctModels, distinctProjects, distinctSkills } from './lib/select.ts';
import { formatCount, formatRelative, modelLabel } from './lib/format.ts';
import { useLiveUsage } from './lib/stream.ts';
import type { StreamStatus } from './lib/stream.ts';
import { Overview } from './panels/Overview.tsx';
import { Breakdown } from './panels/Breakdown.tsx';
import { Skills } from './panels/Skills.tsx';
import { Cache } from './panels/Cache.tsx';
import { Sessions } from './panels/Sessions.tsx';
import { Feed } from './panels/Feed.tsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'breakdown', label: 'Breakdown' },
  { id: 'skills', label: 'Skills' },
  { id: 'cache', label: 'Cache' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'feed', label: 'Feed' },
] as const satisfies ReadonlyArray<{ id: string; label: string }>;

type PanelData = {
  events: UsageEvent[];
  toolCalls: ToolCall[];
  sessionCosts: SessionCost[];
  /** Unfiltered on purpose: turns are the boundaries runs are cut on, not events to select. */
  humanTurns: HumanTurn[];
  serverNow: number;
  status: StreamStatus;
  lastEventAt: number | null;
  backfilling: boolean;
  eventCount: number;
};

// A switch rather than a component registry. Each panel takes only what it needs, and a
// shared props type would force every one of them to widen to the union of all six.
function renderPanel(id: TabId, data: PanelData): ReactNode {
  switch (id) {
    case 'overview':
      return (
        <Overview
          events={data.events}
          serverNow={data.serverNow}
          status={data.status}
          lastEventAt={data.lastEventAt}
          backfilling={data.backfilling}
          eventCount={data.eventCount}
        />
      );
    case 'breakdown':
      return <Breakdown events={data.events} loading={data.backfilling} />;
    case 'skills':
      return (
        <Skills events={data.events} toolCalls={data.toolCalls} loading={data.backfilling} />
      );
    case 'cache':
      return <Cache events={data.events} loading={data.backfilling} />;
    case 'sessions':
      return (
        <Sessions
          events={data.events}
          sessionCosts={data.sessionCosts}
          humanTurns={data.humanTurns}
        />
      );
    case 'feed':
      return <Feed events={data.events} serverNow={data.serverNow} />;
  }
}

type TabId = (typeof TABS)[number]['id'];

type RangeId = '24h' | '7d' | '30d' | 'all' | 'custom';

const DAY_MS = 86_400_000;

const RANGES: ReadonlyArray<{ id: RangeId; label: string; spanMs: number | null }> = [
  { id: '24h', label: '24h', spanMs: DAY_MS },
  { id: '7d', label: '7d', spanMs: 7 * DAY_MS },
  { id: '30d', label: '30d', spanMs: 30 * DAY_MS },
  { id: 'all', label: 'All', spanMs: null },
  { id: 'custom', label: 'Custom', spanMs: null },
];

const SCOPES: ReadonlyArray<{ value: AgentScope; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'main', label: 'Main' },
  { value: 'sub', label: 'Subagents' },
];

type ThemeMode = 'system' | 'light' | 'dark';

const THEMES: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const THEME_KEY = 'token-dashboard.theme';
const RANGE_KEY = 'token-dashboard.range';
const STYLE_ID = 'token-dashboard-shell';
const FRESH_MS = 120_000;

function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      return;
    }
  }, [mode]);

  return [mode, setMode];
}

function currentTab(): TabId {
  const id = window.location.hash.replace(/^#\/?/, '');
  const match = TABS.find((tab) => tab.id === id);
  return match === undefined ? 'overview' : match.id;
}

function useHashTab(): [TabId, (id: TabId) => void] {
  const [tab, setTab] = useState<TabId>(currentTab);

  useEffect(() => {
    const sync = () => setTab(currentTab());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  return [tab, (id: TabId) => { window.location.hash = id; }];
}

function readRange(): RangeId {
  try {
    const stored = localStorage.getItem(RANGE_KEY);
    const match = RANGES.find((range) => range.id === stored);
    return match === undefined ? 'all' : match.id;
  } catch {
    return 'all';
  }
}

function toDateInput(ts: number | null): string {
  if (ts === null) return '';
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function fromDateInput(value: string, edge: 'start' | 'end'): number | null {
  if (value === '') return null;
  const ms = new Date(`${value}T${edge === 'start' ? '00:00:00' : '23:59:59.999'}`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

type ShellState = 'booting' | 'unreachable' | 'ready';

function shellState(eventCount: number, status: StreamStatus, backfilling: boolean): ShellState {
  if (eventCount > 0) return 'ready';
  if (status === 'error' || status === 'reconnecting') return 'unreachable';
  return status === 'connecting' || backfilling ? 'booting' : 'ready';
}

type Pulse = { dot: string; tone: string; label: string };

function pulse(status: StreamStatus, lastEventAt: number | null, serverNow: number): Pulse {
  if (status === 'connecting') return { dot: 'offline', tone: '', label: 'connecting' };
  if (status === 'reconnecting') return { dot: 'offline', tone: 'pill-warning', label: 'reconnecting' };
  if (status === 'error') return { dot: 'offline', tone: 'pill-danger', label: 'offline' };
  if (lastEventAt === null) return { dot: 'stale', tone: '', label: 'no events' };
  return serverNow - lastEventAt < FRESH_MS
    ? { dot: '', tone: 'pill-positive', label: 'live' }
    : { dot: 'stale', tone: '', label: formatRelative(lastEventAt, serverNow) };
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function MultiSelect({
  noun,
  options,
  selected,
  onChange,
}: {
  noun: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (wrap.current !== null && target instanceof Node && !wrap.current.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const chosen = new Set(selected);
  const needle = query.trim().toLowerCase();
  const shown = needle === '' ? options : options.filter((o) => o.label.toLowerCase().includes(needle));
  const single = selected.length === 1 ? options.find((o) => o.value === selected[0]) : undefined;
  const summary =
    selected.length === 0
      ? `All ${noun}s`
      : single !== undefined
        ? single.label
        : `${selected.length} ${noun}s`;

  const toggle = (value: string) => {
    onChange(chosen.has(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <div className="ms" ref={wrap}>
      <button
        type="button"
        className={selected.length > 0 ? 'ms-btn on' : 'ms-btn'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {summary}
        <span aria-hidden="true" className="muted">
          ▾
        </span>
      </button>
      {open ? (
        <div className="ms-menu">
          {options.length > 10 ? (
            <input
              className="ms-search"
              type="search"
              placeholder={`Filter ${noun}s`}
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          <div className="ms-list">
            {shown.length === 0 ? <div className="muted ms-opt">No matches</div> : null}
            {shown.map((option) => (
              <label key={option.value} className="ms-opt">
                <input
                  type="checkbox"
                  checked={chosen.has(option.value)}
                  onChange={() => toggle(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <div className="ms-foot">
            <span className="muted">{`${options.length} ${noun}s in window`}</span>
            {selected.length > 0 ? (
              <button type="button" className="linkish" onClick={() => onChange([])}>
                Clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterBar({
  range,
  onRange,
  onResetAll,
  projectOptions,
  modelOptions,
  skillOptions,
  matched,
  total,
}: {
  range: RangeId;
  onRange: (next: RangeId) => void;
  onResetAll: () => void;
  projectOptions: ReadonlyArray<{ value: string; label: string }>;
  modelOptions: ReadonlyArray<{ value: string; label: string }>;
  skillOptions: ReadonlyArray<{ value: string; label: string }>;
  matched: number;
  total: number;
}) {
  const { filters, patch, isDefault } = useFilters();

  return (
    <div className="bar">
      <div className="field">
        <span className="field-label">Range</span>
        <Segmented label="Date range" options={RANGES.map((r) => ({ value: r.id, label: r.label }))} value={range} onChange={onRange} />
      </div>

      {range === 'custom' ? (
        <div className="field">
          <input
            className="date-input"
            type="date"
            aria-label="From date"
            value={toDateInput(filters.from)}
            onChange={(event) => patch({ from: fromDateInput(event.target.value, 'start') })}
          />
          <span className="muted">to</span>
          <input
            className="date-input"
            type="date"
            aria-label="To date"
            value={toDateInput(filters.to)}
            onChange={(event) => patch({ to: fromDateInput(event.target.value, 'end') })}
          />
        </div>
      ) : null}

      <div className="field">
        <span className="field-label">Project</span>
        <MultiSelect
          noun="project"
          options={projectOptions}
          selected={filters.projects}
          onChange={(projects) => patch({ projects })}
        />
      </div>

      <div className="field">
        <span className="field-label">Model</span>
        <MultiSelect
          noun="model"
          options={modelOptions}
          selected={filters.models}
          onChange={(models) => patch({ models })}
        />
      </div>

      <div className="field">
        <span className="field-label">Skill</span>
        <MultiSelect
          noun="skill"
          options={skillOptions}
          selected={filters.skills}
          onChange={(skills) => patch({ skills })}
        />
      </div>

      <div className="field">
        <span className="field-label">Scope</span>
        <Segmented label="Agent scope" options={SCOPES} value={filters.agentScope} onChange={(agentScope) => patch({ agentScope })} />
      </div>

      {isDefault ? null : (
        <div className="bar-end">
          {matched < total ? (
            <>
              <span className="pill pill-accent">Filtered</span>
              <span className="secondary count">
                {`${formatCount(matched)} of ${formatCount(total)} requests`}
              </span>
            </>
          ) : null}
          <button type="button" className="linkish" onClick={onResetAll}>
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

type BoundaryState = { error: Error | null };

class PanelBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('panel crashed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="card">
        <h2>This panel crashed</h2>
        <p className="secondary">{error.message}</p>
        <button type="button" className="linkish" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

function Dashboard() {
  const usage = useLiveUsage();
  const { filters, patch, reset } = useFilters();
  const [range, setRange] = useState<RangeId>(readRange);
  const [tab, setTab] = useHashTab();
  const [theme, setTheme] = useTheme();

  const minute = Math.floor(usage.serverNow / 60_000);

  useEffect(() => {
    try {
      localStorage.setItem(RANGE_KEY, range);
    } catch {
      return;
    }
  }, [range]);

  /*
   * Deps stay coarse on purpose. A rolling preset has to keep sliding while the
   * page sits open, but depending on serverNow would repatch the filter every
   * second and re-run applyFilters over every event.
   */
  useEffect(() => {
    if (range === 'custom') return;
    const span = RANGES.find((entry) => entry.id === range)?.spanMs ?? null;
    patch({ from: span === null ? null : usage.serverNow - span, to: null });
  }, [range, minute]);

  const events = useMemo(() => applyFilters(usage.events, filters), [usage.events, filters]);

  const projectOptions = useMemo(
    () => distinctProjects(usage.events).map((project) => ({ value: project, label: project })),
    [usage.events],
  );
  const modelOptions = useMemo(
    () => distinctModels(usage.events).map((model) => ({ value: model, label: modelLabel(model) })),
    [usage.events],
  );
  const skillOptions = useMemo(
    () => distinctSkills(usage.events).map((skill) => ({ value: skill, label: skill })),
    [usage.events],
  );

  const beat = pulse(usage.status, usage.lastEventAt, usage.serverNow);
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];
  const state = shellState(usage.eventCount, usage.status, usage.backfilling);

  const resetAll = () => {
    setRange('all');
    reset();
  };

  return (
    <div className="shell">
      <div className="top">
        <div className="bar">
          <div className="brand">
            <h1>Claude Token Dashboard</h1>
            <span className="muted">local usage</span>
          </div>
          <span className={`pill ${beat.tone}`}>
            <span className={`live-dot ${beat.dot}`} />
            {beat.label}
          </span>
          <div className="bar-end">
            <span className="secondary count">{`${formatCount(usage.eventCount)} requests in window`}</span>
            <Segmented label="Colour theme" options={THEMES} value={theme} onChange={setTheme} />
          </div>
        </div>

        <FilterBar
          range={range}
          onRange={setRange}
          onResetAll={resetAll}
          projectOptions={projectOptions}
          modelOptions={modelOptions}
          skillOptions={skillOptions}
          matched={events.length}
          total={usage.eventCount}
        />

        <div className="tabs" role="tablist" aria-label="Dashboard sections">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === tab}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {state === 'booting' ? (
        <div className="boot">
          <div className="boot-card">
            <div className="spinner" />
            <h2>{usage.backfilling ? 'Reading 30 days of transcripts' : 'Connecting to the tailer'}</h2>
            <p className="secondary">
              {usage.backfilling
                ? 'The first backfill walks every transcript under ~/.claude/projects. This takes a moment.'
                : 'Opening the event stream on port 4317.'}
            </p>
          </div>
        </div>
      ) : null}

      {state === 'unreachable' ? (
        <div className="boot">
          <div className="boot-card">
            <h2>No connection to the dashboard server</h2>
            <p className="secondary">
              Nothing has arrived on /api/events yet. Start the server with <code>npm run server</code>; this
              page keeps retrying on its own.
            </p>
            <span className={`pill ${beat.tone}`}>{beat.label}</span>
          </div>
        </div>
      ) : null}

      {state === 'ready' ? (
        <main className="main" role="tabpanel" aria-label={active.label}>
          {usage.status === 'error' ? (
            <div className="notice bad">
              <strong>Stream offline.</strong>
              <span className="secondary">
                The dashboard is still retrying in the background. Numbers below are the last data received.
              </span>
            </div>
          ) : null}

          {usage.status === 'reconnecting' ? (
            <div className="notice warn">
              <strong>Reconnecting.</strong>
              <span className="secondary">Showing the last data received.</span>
            </div>
          ) : null}

          {usage.backfilling ? (
            <div className="notice warn">
              <div className="spinner" />
              <strong>Backfilling history.</strong>
              <span className="secondary count">
                {`${formatCount(usage.eventCount)} requests ingested so far. Totals will keep climbing.`}
              </span>
            </div>
          ) : null}

          {usage.eventCount === 0 ? (
            <div className="notice">
              <strong>No usage recorded.</strong>
              <span className="secondary">
                The store is empty, so there are no transcripts with billed requests in the last 30 days.
              </span>
            </div>
          ) : null}

          {events.length === 0 && usage.eventCount > 0 ? (
            <div className="notice">
              <strong>No requests match these filters.</strong>
              <span className="secondary">
                {`${formatCount(usage.eventCount)} requests are in the window.`}
              </span>
              <button type="button" className="linkish" onClick={resetAll}>
                Reset filters
              </button>
            </div>
          ) : null}

          <PanelBoundary key={active.id}>
            {renderPanel(active.id, {
              events,
              toolCalls: usage.toolCalls,
              sessionCosts: usage.sessionCosts,
              humanTurns: usage.humanTurns,
              serverNow: usage.serverNow,
              status: usage.status,
              lastEventAt: usage.lastEventAt,
              backfilling: usage.backfilling,
              eventCount: usage.eventCount,
            })}
          </PanelBoundary>
        </main>
      ) : null}
    </div>
  );
}

/** A <style> rendered in the tree leaks its CSS text into the accessibility name of the root. */
function useShellStyles() {
  useLayoutEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return;
    const tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = SHELL_CSS;
    document.head.append(tag);
  }, []);
}

export function App() {
  useShellStyles();
  return (
    <FiltersProvider>
      <Dashboard />
    </FiltersProvider>
  );
}

const SHELL_CSS = `
.shell { min-height: 100vh; display: flex; flex-direction: column; }

.top {
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding: var(--sp-3) var(--sp-5);
}
.bar + .bar { padding-top: 0; }

.brand { display: flex; align-items: baseline; gap: var(--sp-2); }
.brand h1 { font-size: 16px; white-space: nowrap; }
.brand span { font-size: 12px; }

.bar-end {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-left: auto;
}
.count { font-variant-numeric: tabular-nums; white-space: nowrap; }

.field { display: inline-flex; align-items: center; gap: var(--sp-2); }
.field-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.seg {
  display: inline-flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}
.seg button {
  appearance: none;
  background: none;
  border: none;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}
.seg button + button { border-left: 1px solid var(--border); }
.seg button:hover { background: var(--surface-hover); color: var(--text); }
.seg button[aria-pressed='true'] { background: var(--accent-soft); color: var(--accent); }

.ms { position: relative; }
.ms-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  max-width: 220px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ms-btn:hover { background: var(--surface-hover); }
.ms-btn.on { border-color: var(--accent); color: var(--accent); }

.ms-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 40;
  width: 280px;
  max-height: 340px;
  display: flex;
  flex-direction: column;
  padding: var(--sp-2);
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-2);
}
.ms-search {
  width: 100%;
  margin-bottom: var(--sp-2);
  padding: 4px 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.ms-list { overflow-y: auto; }
.ms-opt {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 4px 6px;
  border-radius: var(--r-sm);
  font-size: 13px;
  cursor: pointer;
}
.ms-opt:hover { background: var(--surface-hover); }
.ms-opt span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
  font-size: 11px;
}

.linkish {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.linkish:hover { text-decoration: underline; }

.date-input {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 3px 8px;
  font-size: 12px;
}

.tabs { display: flex; gap: var(--sp-1); padding: 0 var(--sp-5); }
.tabs button {
  background: none;
  border: none;
  margin-bottom: -1px;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 2px solid transparent;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
}
.tabs button:hover { color: var(--text); }
.tabs button[aria-selected='true'] { color: var(--text); border-bottom-color: var(--accent); }

.main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-5);
  min-width: 0;
}

.notice {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  font-size: 13px;
}
.notice.warn { border-color: transparent; background: color-mix(in srgb, var(--warning) 18%, var(--surface)); }
.notice.bad { border-color: transparent; background: color-mix(in srgb, var(--danger) 14%, var(--surface)); }

.boot { flex: 1 1 auto; display: grid; place-items: center; padding: var(--sp-6); }
.boot-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  max-width: 440px;
  text-align: center;
}

.spinner {
  width: 18px;
  height: 18px;
  flex: none;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; }
}
`;
