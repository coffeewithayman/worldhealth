# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # tsc --build (project references); every other script runs this first
npm test               # builds, then node --test over packages/*/dist/**/*.test.js
npm run migrate        # create/upgrade the SQLite schema at data/world.db
npm run backfill       # deep history (25y default) — needed before percentile scoring is meaningful
npm run daily          # ingest → derive → score; the scheduler entrypoint
npm run doctor         # probe every upstream source, write nothing (fastest triage)
npm run sources        # connector list + which are disabled for a missing key
npm run api            # Hono server on :8787
npm run dev            # api + Vite dev server (:5173, proxies /api to :8787)
```

Run a single test by name pattern against the built output:

```bash
npm run build && node --test --test-name-pattern="FIMA repo bands" packages/core/dist/scoring.test.js
```

Things the npm scripts do not cover:

- **`npm run build` does not build the web bundle.** The root `tsconfig.json` references only core, connectors, ingest and api. `npm run api` serves `packages/web/dist` only if it exists — build it with `npm -w @wd/web run build`, or use `npm run dev` instead.
- **Web is type-checked separately**: `npm -w @wd/web exec tsc -- --noEmit`. Nothing in `npm run build` or `npm test` catches a type error in `packages/web`.
- **`derive` and `health` are CLI subcommands with no npm script**: `node packages/ingest/dist/cli.js derive` (recompute derived series without refetching), `... health` (list stale series).
- `npm run api` exits if `data/world.db` is absent — migrate first.

CLI flags (ingest/backfill/doctor/score): `--only <id,id>`, `--since YYYY-MM-DD`, `--dry-run`, `--no-cache`, `--as-of YYYY-MM-DD` (point-in-time scoring, for backtests).

## Architecture

npm workspaces, strict TypeScript, ESM + `NodeNext`. Dependency direction is one-way: `core ← connectors ← ingest ← api`. `web` depends on nothing internal and talks only to the HTTP API.

```
config/indicators.yaml   THE model — weights, thresholds, transforms. Not code.
packages/core/           types, Store interface, scoring, derived series, stats, quotes, board
packages/connectors/     one module per upstream source, uniform Connector interface
packages/ingest/         CLI: migrate, doctor, ingest, backfill, derive, score, daily, health
packages/api/            Hono routes; Node today, Workers later unchanged
packages/web/            React + Vite, hash routing, hand-rolled SVG charts
data/world.db            SQLite (gitignored)
```

**Everything is a time series.** Every connector — SDMX, ArcGIS, XML, CSV, JSON — normalises to `Observation { seriesId, obsDate, value }`. Storage, scoring, charting and staleness are written once, not once per source. Resist any design that needs a source-specific path through the pipeline.

**The pipeline** is ingest → derive → score. Connectors write raw series; `DERIVATIONS` in `core/src/derived.ts` compute analysis series from stored data (`d.*` ids); `core/src/scoring.ts` turns config-declared indicators into 0–100 stress scores, aggregates to pillars, then to a composite. `core/src/watchlist.ts` evaluates the depression precursors, which stay deliberately *outside* the weighted composite.

**Series-id namespaces** are by origin, not by pillar: `us.` `em.` `fx.` `metal.` `oil.` `gas.` `cmd.` `semi.` `mkt.` `crypto.` (connector-written), `ust.` (Treasury curve), and `d.` for everything derived. A `d.` id that no derivation produces silently scores nothing.

**Ordering:** `DERIVATIONS` order is semantic — a derivation may read a series computed earlier in the same pass (`d.gold_breadth` needs the per-currency `d.gold.*` above it). The `CONNECTORS` registry order is cosmetic only; connectors run concurrently.

## Invariants worth knowing before editing

These are enforced by tests and by deliberate design; breaking one is usually a silent wrong answer rather than a crash.

- **Point-in-time scoring.** Only observations at or before the as-of date are visible, for both the current value *and* the distribution it is ranked against. `--as-of` backtesting is only honest because of this.
- **Missing beats wrong.** A stale input is dropped from scoring (not carried forward); a pillar below `MIN_PILLAR_COVERAGE` (0.34) is excluded from the composite (not averaged in); a watchlist item with missing inputs reports `unavailable` (never `clear`).
- **Staleness budgets come from publication lag, not cadence.** Observations are labelled at period start, so a monthly series needs ~80 days and quarterly bank data ~260. Budgets tuned to cadence flag healthy data as broken.
- **`bands` vs `percentile` is a modelling decision, not a style choice.** Percentile cannot express non-monotonic risk (M2 growth and real yields are dangerous at *both* extremes) and degenerates on mostly-zero series (FIMA repo is zero in ~93% of weeks, so its median, p75 and p95 are all 0). Both cases must use `bands`.
- **Every score carries its arithmetic.** `ScoreRecord.inputs` and `IndicatorScore.explanation` are what make the model auditable in the UI. Never write a score without them.
- **Connector failures are isolated.** One broken feed must not abort the rest; every outcome including failure is written to `source_runs`, which is what the Sources tab reads.
- **SQL stays portable.** `INSERT … ON CONFLICT DO UPDATE` only (never `INSERT OR REPLACE`), TEXT for dates, no SQLite extensions. Every `Store` method is async although SQLite is synchronous, so D1/Postgres is a one-file swap.
- **Credentials never reach a log, an error or the DB.** `core/src/http.ts` `redactUrl()` strips key-ish query params; connector errors are persisted to `source_runs.error` and served by `/api/sources`.
- **`raw_cache` is replayability, not performance.** It keeps verbatim upstream bodies so a parsing bug can be fixed and re-run against yesterday's exact bytes without burning a free-tier quota. `--no-cache` bypasses it.
- **Quote arithmetic is server-side** in `core/src/quotes.ts` — change windows, 52-week range, 5-year percentile, sparkline. A change window shorter than the series' publication gap is omitted rather than forward-filled, and rate-like units report basis points, not a percent of a percent.
- **The API scores live from `config/indicators.yaml`** on each request; the `scores` table is only read for *history*. Editing weights shows up on refresh without re-running the scorer.
- **`WATCHLIST_SERIES` is duplicated** in `packages/api/src/routes.ts` and `packages/ingest/src/score.ts`. A new watchlist rule needs both lists updated or the API and CLI disagree.

## Adding things

**A data source:** write one module in `packages/connectors/src/` exporting a `Connector`, append it to `CONNECTORS` in `index.ts`. Nothing else changes. Declare series inline (connectors own their own metadata) and set `stalenessBudgetDays` from publication lag. Use the shared `util.ts` parsers — `num()` returns null rather than NaN for the many "no data" spellings, because NaN corrupts percentile ranks silently.

**An indicator:** commit `f668663` is the template to follow — connector catalog entry, `config/indicators.yaml` block with a justified transform, a test pinning the behaviour that would break if the transform were swapped, and a README line. Verify against live data at two dates (a quiet one and a known firing) before committing.

**A derived series:** add a `Derivation` to `DERIVATIONS`, positioned after anything it reads. Required `inputs` missing skips it with a warning; `optionalInputs` may be absent.

**A markets board row:** `core/src/board.ts`. Curation lives there because what belongs on a price board is a domain judgement, and the same list tells ingest what must stay fresh. `bp: true` is curated per row, not inferred from the unit — "percent" covers both yields (bp) and unemployment (not bp).

## Configuration and keys

Keys load from `.env.local`, then `.env`, and a real environment variable beats both (`FRED_API_KEY=x npm run ingest` always wins). Blank values are ignored. Everything runs keyless at roughly 40% coverage; `FRED_API_KEY` is by far the biggest unlock (the credit, real-economy and markets pillars are empty without it). Overrides: `WD_DB_PATH`, `WD_CONFIG_PATH`, `PORT`.

`loadScoringConfig()` validates strictly and throws — unknown pillar, non-positive weight, unsorted bands, duplicate series. That is intentional: a model that silently scores fewer inputs than you think is worse than one that refuses to start.

## Sources already evaluated and rejected

Do not re-attempt these; the README records why in full. **stooq** (JS proof-of-work challenge), **Yahoo Finance** (429s within a handful of requests, needs cookie+crumb), **Baltic Dry / Freightos / Drewry** (genuinely paywalled), **World Gold Council reserves** (login required — IMF SDMX is the open path and the obvious next connector). Silicon, polysilicon, cobalt, lithium and rare earths have no free reference price at all; the semiconductor panel approaches the chip cycle from four measurable angles instead of fabricating one.
