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

Consequences: **dedupe by `requestId` or every metric doubles.** `thinking` is a subset of
`output`, so never add it into a token total. Cache reads dominate volume by ~40x, so any
chart that stacks them raw will flatten everything else.

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
| B1 | `server/parse.ts` | One transcript line → `UsageEvent \| SessionCost \| null` |
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
| F8 | `web/src/panels/sessions.tsx` | Session table + drill-down, live feed |
| F9 | `web/src/App.tsx` + global filter bar | Layout, filters, routing between panels |

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

**Rhythm.** A day-by-hour heatmap of token volume, and thinking tokens as a share of output.

**Filters.** Date range, project, model, and main-versus-subagent, applied globally to
every panel. All client-side, so they are instant.

## Correctness bar

`scripts/validate.ts` must pass. It is the lever that proves the pipeline. Five checks, each
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

## What the measurements turned up

Three findings that changed the design, all reproducible through the validator:

**Session resume duplicates requests.** Resuming a session copies its earlier requests into the
new transcript, so about 1% of `requestId`s appear in two files under two different
`sessionId`s. The primary key keeps totals correct, but attribution went to whichever file was
read first, which made per-session numbers shift between rebuilds. The scanner now walks files
oldest-first, which is deterministic and hands requests to the session that made them.

**A `cost-state` record covers one incarnation, not the whole file.** Its `startTime` can post-
date the transcript's earliest request by hours. Summing a whole transcript against it
overstated one session by 8x. Per-session cost comparisons scope to `ts >= startTime`.

**Cost is a lower bound, by about 7%.** The transcripts hold 98% of billed cache reads but only
60% of billed output tokens and 3% of billed fresh input, because Claude Code bills internal
calls it never journals. Those missing tokens are the expensive kind. This is not a pricing
error; check 2 proves the rate table exactly. Web search is billed at $0.01 per request on top
of tokens, which check 2 caught as six Haiku rows short by exactly one cent per search.

"It compiles" is not verification. The dashboard must be driven in a real browser and
show real numbers before any of this is called done.
