# Claude Token Dashboard

A local real-time dashboard for this machine's Claude Code usage. It seeds from 30 days of
transcript history and then updates live as new requests land, without a page refresh.

## Run it

```
npm install
npm run dev          # API on :4317, dashboard on http://localhost:5273
```

`npm run dev` supervises both processes and shuts them down together on Ctrl-C. To run them
separately, use `npm run server` and `npm run web`.

For a single-process deployment, `npm run build` emits the frontend and `npm run server`
serves it directly from the API port.

## What it reads

Everything comes from the transcripts Claude Code already writes to
`~/.claude/projects/**/*.jsonl`. Nothing is sent anywhere, no API key is needed, and the
dashboard never writes to those files. Its own state lives in `data/usage.db`, which is
disposable: delete it and the next start rebuilds it from the transcripts.

The one thing to know about the data: Claude Code writes each API request to the transcript
once per content block, so the raw line count is about twice the request count. Every metric
here is deduped by `requestId`. Aggregating raw lines doubles every number, which is why the
store makes `requestId` a primary key rather than deduping in application code.

`thinking` tokens are a subset of `output` tokens and are never added into a token total.

## What a skill costs

Claude Code stamps each request with the skill loaded in its context, so the dashboard can
rank skills by what they actually cost. About 35% of requests carry a skill. The ranking
shows the main-thread and subagent split for each one, which matters because a skill that
fans out subagents spends most of its money there rather than in the turn that invoked it.

Tool calls are counted at a finer grain than requests: one request issues between one and
thirteen of them, so they are stored separately and keyed by the tool-use block id. A tool
call has no cost of its own, and the dashboard does not invent one. The cost columns on the
tool tables are the cost of the **requests** that called that tool, which means a request
calling three tools contributes to three rows and the shares add up to more than 100%. The
tables say so where they show it.

MCP servers and tools are read off the `mcp__<server>__<tool>` name. The transcripts also
carry `attributionMcpServer` and `attributionMcpTool` fields, which look like the obvious
source and are not: they disagree with the tool actually invoked on their own line, so
nothing here reads them. `SPEC.md` has the measurements.

## How long a session runs, and how long it runs alone

The transcripts record every request Claude Code made and every tool it called, but nothing in
them says when *you* typed. So the dashboard reads that separately, off the `type:"user"` lines
that survive a filter: no tool results, no subagent prompts, no injected context, and no
messages from another Claude session. What is left is a person acting. Over 30 days that is
791 turns. Four of the 285 sessions in the window have none of them, and the largest of those
four is seven requests: work another session started.

With those boundaries the Sessions panel can show two things the request stream alone cannot.
Session length, where the median leads because the mean is 4h against a median of 10 minutes:
sessions left open overnight drag the average, and the median is the one that describes a
working day. And the longest run without human input, meaning the longest stretch of requests
with no turn of yours inside it.

A run also ends after 30 minutes of silence. Without that cut the longest "unattended run" is
three and a half days, almost all of it one idle gap around four requests, which measures a
laptop left open rather than an agent working. Of 31,428 gaps between consecutive requests in a
window, only 79 run past 30 minutes, so the cut lands in the tail rather than through the
middle of anything. The answer does move with it, from 3.2h at a 5-minute cut to 7.8h at half
an hour, which is why the tile shows the run's request count next to its duration.
`npm run validate` asserts that under 1% of gaps run past the cut, so the number cannot rot
quietly as habits change.

## Cost is a lower bound

Token counts here are essentially complete: the transcripts hold 98% of the cache reads and
99% of the cache writes that Claude Code reports billing. Cost is not. The transcripts carry
only about 60% of billed output tokens and 3% of billed fresh input, because Claude Code bills
internal calls (conversation titles, summaries, compaction) that it never writes as an
assistant line. Those missing tokens are the expensive kind, so derived cost lands around 93%
of reported cost.

That gap is a property of the data source, not a pricing error. The rate table is verified
exactly: `cost-state` records Claude Code's own token counts alongside its own dollar figure,
and re-pricing those counts reproduces that figure for all 175 model rows. `npm run validate`
reports the current coverage, and the session table flags any session whose derived cost sits
more than 10% off Claude Code's own total.

## Checking it is right

```
npm run validate
```

`scripts/validate.ts` re-counts distinct requests, distinct tool calls and human turns with its
own independent reader, compares derived cost against the `totalCostUSD` Claude Code records for
each session, re-runs the backfill to prove ingest is idempotent, asserts the per-event
invariants, proves no request carries two different skill attributions, since the per-skill cost
figures rest on that, and checks that the 30-minute idle cut still sits in the tail of the gap
distribution. It exits non-zero on failure, so it is the thing to run after any change to the
ingest path rather than trusting the dashboard to look plausible.

## Layout

```
shared/types.ts    the contract every module shares
server/            parse, price, store, tail, watch, serve.  Zero npm dependencies.
web/src/lib/       stream, filters, aggregation, formatting
web/src/charts/    hand-rolled SVG chart primitives
web/src/panels/    the dashboard panels
scripts/           dev supervisor and validator
```

The backend deliberately does no aggregation. Thirty days is about 17k events, small enough
to hand the browser in full, so the server tails, dedupes, prices, persists and streams while
the frontend computes every panel locally. That is what makes the filters instant.

`SPEC.md` records the measurements behind those choices.
