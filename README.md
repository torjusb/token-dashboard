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

`scripts/validate.ts` re-counts distinct requests with its own independent reader, compares
derived cost against the `totalCostUSD` Claude Code records for each session, re-runs the
backfill to prove ingest is idempotent, and asserts the per-event invariants. It exits
non-zero on failure, so it is the thing to run after any change to the ingest path rather
than trusting the dashboard to look plausible.

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
