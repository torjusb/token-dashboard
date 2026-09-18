# Claude Token Dashboard

A local, real-time dashboard for this machine's Claude Code usage. Seeds from 30 days
of transcript history, then updates live as new requests land, with no page refresh.

## Verified facts (measured, do not re-litigate)

| Fact | Evidence |
| --- | --- |
| Source of truth is `~/.claude/projects/**/*.jsonl` | 498 files, 344 MB |
| Usage lives on `type:"assistant"` lines at `message.usage` | sampled |
| **Raw lines are duplicated ~2.00x**; the same `requestId` repeats once per content block | 33,961 raw lines dedupe to 16,999 over 30d |
| 30-day volume: ~17k requests, ~195 sessions, ~2.76B tokens | measured |
| `type:"cost-state"` lines carry Claude Code's own `totalCostUSD` + per-model `costUSD` | sampled; 144 sessions, $1008 lifetime |
| Subagent traffic is ~40% of requests, tagged `isSidechain` + `attributionAgent` | measured |
| Recursive `fs.watch` on the projects dir fires on transcript appends | 12s probe caught 2 live sessions |
| `node:sqlite` and native TypeScript both work in Node 26.8.1 | probed |
| `attributionSkill` on assistant lines names the skill loaded in context | 6,812 of 19,190 requests (35.5%), 32 distinct skills |
| Skill attribution is consistent across a request's duplicate lines | all 6,813 skill-attributed requestIds carry exactly 1 distinct value |
| `attributionPlugin` is **not** derivable from the skill name prefix | pstack: 9,584 lines vs 7,594 from pstack skills |
| `message.content` is always a list of length 1 | 38,363 of 38,363 assistant lines |
| A request issues 1 to 13 `tool_use` blocks | 21,513 distinct ids over 19,335 requests |
| One transcript is reachable by two paths, a symlink beside its real file | 165 tool-use ids repeat under session resume once the symlink is excluded, 243 if it is not |
| `attributionMcpServer` / `attributionMcpTool` disagree with the block on their own line | 203 claude-in-chrome calls with a null server; tool field names a different tool 60+ times per pair |
| Human input reaches the transcript only on `type:"user"` lines, and only some of those are people | 791 turns over 30d; 4 of the 285 sessions with requests have none, and the largest of those four holds 7 requests |
| Claude Code labels cross-session teammate messages `origin.kind:"peer"` only from 2.1.266 | 155 lines in the window are teammate messages with no `origin` field at all |
| Inter-request gaps cluster far below half an hour | 31,428 gaps over 30d, 99.5% under 15 min, only 79 over 30 min |
| Every cache write in the window is 1-hour ephemeral | 100% of `cache_creation` tokens, so the 5-minute TTL is not a clock anything here can use |

Consequences: **dedupe by `requestId` or every metric doubles.** `thinking` is a subset of
`output`, so never add it into a token total. Cache reads dominate volume by ~40x, so any
chart that stacks them raw will flatten everything else. Bash dominates tool calls by ~9x for
the same reason. **MCP server and tool come from splitting the `mcp__<server>__<tool>` name,
never from the `attributionMcp*` fields**, which read as lagging context markers rather than a
record of the call.

## Architecture

The 30-day dataset is ~17k events, small enough to hand the browser in full. So the
backend does not aggregate. It tails, dedupes, prices, persists and streams; the frontend
holds every event and computes every panel locally. That makes filters and drill-downs
instant with no round-trip, and keeps the server surface to two endpoints.

```
~/.claude/projects/**/*.jsonl
        │  recursive fs.watch  +  byte-offset tail
        ▼
  parse.ts ──► pricing.ts ──► store.ts (node:sqlite, PK = requestId)
                                  │
                                  ▼
                        http.ts  GET /api/snapshot
                                 GET /api/events   (SSE: snapshot, delta, heartbeat)
                                  │
                                  ▼
                  web: stream.ts ──► select.ts ──► panels + charts
```

Zero runtime dependencies on the server: `node:sqlite`, `node:http`, `node:fs` only.
Run it with `node server/main.ts` — Node strips the types natively, there is no build step.

The contract is `shared/types.ts`. Read it first. It is authoritative; if a field is
missing for your panel, add it there and say so, do not invent a parallel shape.

## Ownership map

Each file has exactly one owner. Do not edit a file you do not own; if you need a change
in someone else's file, report it instead.

| # | File | Job |
| --- | --- | --- |
| B1 | `server/parse.ts` | One transcript line → `UsageEvent` + its `ToolCall`s, `SessionCost`, `HumanTurn`, or nothing |
| B2 | `server/pricing.ts` | Per-model token pricing, `costOf(event)` |
| B3 | `server/store.ts` | SQLite schema, idempotent upsert, snapshot reads, tail offsets |
| B4 | `server/tail.ts` | Byte-offset incremental file reads, partial trailing lines |
| B5 | `server/scan.ts` | 30-day backfill + `fs.watch` + debounce + change queue |
| B6 | `server/http.ts` + `server/main.ts` | REST, SSE hub, static serving, wiring |
| F1 | `web/src/lib/stream.ts` | SSE client, reconnect, event store, React hook |
| F2 | `web/src/lib/select.ts` | Every aggregation the panels need. Pure functions. |
| F3 | `web/src/lib/format.ts` + `web/src/lib/theme.css` | Formatting, design tokens, dark/light |
| F4 | `web/src/charts/*` | Chart primitives: area, bar, donut, heatmap, sparkline |
| F5 | `web/src/panels/overview.tsx` | Live tiles, burn rate, today vs 30d trend |
| F6 | `web/src/panels/breakdown.tsx` | Model / project / subagent / effort breakdowns |
| F7 | `web/src/panels/cache.tsx` | Cache efficiency, 5m vs 1h, savings |
| F8 | `web/src/panels/sessions.tsx` | Session-length and unattended-run tiles, session table + drill-down, live feed |
| F9 | `web/src/App.tsx` + global filter bar | Layout, filters, routing between panels |
| F10 | `web/src/panels/Skills.tsx` | Skill / plugin / tool / MCP-server breakdowns |

## Features

**Live surface.** A freshness pulse driven by `serverNow` minus the newest event, so the
page shows honest staleness instead of a fake "live" badge. Tiles for tokens, cost and
requests today, each against its 30-day daily median. A rolling burn rate in tokens/min
and $/hour with an end-of-day projection.

**Time series.** Tokens per day over the window, split by token kind, with a cost toggle.
Because cache reads are ~40x everything else, the default view must not stack them raw.

**Breakdowns.** Share of tokens, cost and requests by model, by project (`cwd` basename)
with a branch drill-down, by subagent type (`attributionAgent`), and by effort level.

**Cache economics.** Cache read vs write vs fresh input, the 5-minute versus 1-hour
ephemeral split, and what the cache saved against uncached pricing.

**Sessions.** A sortable table keyed by session: `slug`, project, duration, tokens, cost,
model mix. Drill into one session's request timeline. A live feed of recent requests.

**Session length and unattended runs.** Four tiles above that table: sessions in the window,
median session length with the mean beside it, the longest session, and the longest run without
human input. `runs()` in `select.ts` cuts each session into runs and `sessionStats()` reduces
both shapes to the tile figures. The median leads because the mean is 3.99h against a median of
0.17h; sessions left open for days drag it. The longest run shows its request count beside its
duration, because the duration moves with the idle cut and the count is what makes it readable.

Human turns are boundary markers, not events, so they are the one record the global filter bar
does not touch. Runs are computed over whatever filtered events the panel holds, bounded by the
unfiltered turns. Filtering the boundaries would silently merge two runs into one.

**Rhythm.** A day-by-hour heatmap of token volume, and thinking tokens as a share of output.

**Skills and tools.** What each skill costs, ranked by cost with its main-thread versus
subagent split, because a skill that fans out subagents is where the money actually goes.
The same ranking by plugin. Tool calls ranked by count, and MCP servers ranked separately
since that is the actionable slice of a 101-name tail.

A tool call has no cost of its own. Cost columns on the tool tables are the cost of the
**requests** that called the tool, so one request that calls three tools lands in three rows
and the shares sum above 100%. Every such column says so; nothing divides a request's cost
across its tool calls, because there is no basis for the split.

**Filters.** Date range, project, model, skill, and main-versus-subagent, applied globally to
every panel. All client-side, so they are instant. Filtering reaches the tool grain through
the `requestId` join: a tool call counts only when its request survives the filters.

## Correctness bar

`scripts/validate.ts` must pass. It is the lever that proves the pipeline. Eight checks, each
testing one thing:

1. **DEDUPE.** Store count matches an independent recount of distinct `requestId`s, written
   against the raw format rather than calling `parse.ts`, so it can catch a parser bug instead
   of restating it. The raw-to-distinct ratio should sit at about 2.0x.
2. **PRICING.** `cost-state` carries Claude Code's own token counts next to its own dollar
   figure, so re-pricing those counts must reproduce that figure. It lumps the two cache-write
   TTLs into one count, so each row is priced twice, as all-5m and all-1h, and the reported
   cost must fall inside that bracket. Zero rows outside, no tolerance to hide behind.
3. **COVERAGE.** What share of billed tokens and cost the transcripts actually account for,
   reported per token kind. This measures the data source, not our code, so it is informational
   with a floor at 85% to catch an ingest regression.
4. **IDEMPOTENCY.** Re-running the backfill re-ingests nothing. It must distinguish a request
   that genuinely arrived mid-check from one wrongly re-ingested, because this machine is often
   running Claude Code while the validator runs.
5. **INVARIANTS.** No event has `thinking > output`, no negative fields, no duplicate
   `requestId`, every `ts` inside the window.
6. **TOOLCALLS.** Store count matches an independent recount of distinct `tool_use` ids, again
   written against the raw format so it can catch a parser bug instead of restating it. Every
   stored tool call's `requestId` resolves to an event, because the client join depends on it.
7. **ATTRIBUTION.** No `requestId` in the window carries two distinct `attributionSkill`
   values. The whole per-skill cost number rests on that, so it is asserted rather than assumed.
8. **RUNS.** Store count matches an independent recount of human turns, written against the raw
   format rather than calling `parse.ts`, so it can catch a parser bug instead of restating one.
   Then the share of inter-request gaps running past the 30-minute cut must stay under 1%,
   because the longest run is only meaningful while the cut sits in the tail of the gap
   distribution rather than through its body. It is 0.25% today. Working habits drift; the
   constant would otherwise rot unnoticed.

## What the measurements turned up

The findings that changed the design, all reproducible through the validator:

**The transcript walk must not follow symlinks.** One subagent transcript under
`rema-1000-prefetch` exists as a symlink in one session directory pointing at the real file in
another, and both directories are inside the projects root. `readdir` with `withFileTypes`
reports the symlink as not-a-file, so `entry.isFile()` in `server/scan.ts` skips it and the real
path is ingested exactly once. That filter looks like an oversight and is load-bearing:
"fixing" it to follow symlinks would read 26 requests and 78 tool calls twice. The primary keys
would absorb the duplicates, but the raw-versus-distinct ratios the validator reports would
drift and stop meaning anything.

**Session resume duplicates requests.** Resuming a session copies its earlier requests into the
new transcript, so about 1% of `requestId`s appear in two files under two different
`sessionId`s. The primary key keeps totals correct, but attribution went to whichever file was
read first, which made per-session numbers shift between rebuilds. The scanner now walks files
oldest-first, which is deterministic and hands requests to the session that made them.

**A `cost-state` record covers one incarnation, not the whole file.** Its `startTime` can post-
date the transcript's earliest request by hours. Summing a whole transcript against it
overstated one session by 8x. Per-session cost comparisons scope to `ts >= startTime`.

**The MCP attribution fields do not record the call.** `attributionMcpServer` and
`attributionMcpTool` look like the obvious source for per-MCP-tool stats, and they are wrong for
it. On 203 lines a `claude-in-chrome` tool is called with a null server, and the tool field names
a different tool than the block on the same line more than 60 times per pair, `computer` against
`navigate` being the commonest. They behave like markers for the newest MCP result in context,
not a record of what the line invoked. Splitting the `mcp__<server>__<tool>` name is exact, so
that is what `mcpTarget()` does, and the fields are ingested nowhere.

**Most `type:"user"` lines were not typed by a person.** Tool results come back as user lines,
subagent prompts are user lines with `isSidechain`, injected context is a user line with
`isMeta`, and a message from another Claude session is a user line too. A human turn is what
survives dropping all four, plus an `origin.kind` of `"task-notification"` or `"peer"`. Lines
with no `origin` at all stay in, because slash commands like `/clear` and `/compact`,
`<bash-input>` lines, `[Request interrupted by user]` and every prompt from Claude Code before
2.1.186 carry none, and all of them are real human actions. That leniency is what makes the
teammate-message text check load-bearing: 2.1.266 and later label those `origin.kind:"peer"`,
but 155 lines in the window predate it and carry no `origin`, so without a check on the
`Another Claude session sent a message` prefix they read as human input and cut runs short.
The rule finds 791 turns. Of the 285 sessions holding requests, 4 have no turn at all, and the
largest of those four is 7 requests, so they read as work someone else's session kicked off.

**A run needs an idle cut, and the answer moves with it.** Without one, the longest run without
human input is 84.55 hours, of which 84.53 hours is a single idle gap, and the whole stretch
holds 4 requests. That is a laptop left open, not a run. The cut is 30 minutes: of the window's
31,428 inter-request gaps, 99.5% are under 15 minutes and only 79 exceed 30, so it splits
abandonment rather than work. The longest run is 3.21h at a 5- or 10-minute cut and 7.82h from
30 minutes out to an hour, which is why the panel shows the run's request count beside its
duration rather than the duration alone. The obvious anchor is the prompt-cache TTL, and it is
the wrong one: 100% of cache writes in the window are 1-hour ephemeral, so the 5-minute TTL
measures nothing here.

**Cost is a lower bound, by about 7%.** The transcripts hold 98% of billed cache reads but only
60% of billed output tokens and 3% of billed fresh input, because Claude Code bills internal
calls it never journals. Those missing tokens are the expensive kind. This is not a pricing
error; check 2 proves the rate table exactly. Web search is billed at $0.01 per request on top
of tokens, which check 2 caught as six Haiku rows short by exactly one cent per search.

"It compiles" is not verification. The dashboard must be driven in a real browser and
show real numbers before any of this is called done.
