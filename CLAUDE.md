# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # tsc --build (project references); every other script runs this first
npm test               # builds, then node --test over packages/*/dist/**/*.test.js
npm run migrate        # apply pending migrations to DATABASE_URL (Postgres) or data/world.db
npm run copy-store -- --from <world.db>   # one-off: SQLite history → Postgres at DATABASE_URL
npm run backfill       # deep history (25y default) — needed before percentile scoring is meaningful
npm run daily          # ingest → derive → score; the scheduler entrypoint
npm run doctor         # probe every upstream source, write nothing (fastest triage)
npm run sources        # connector list + which are disabled for a missing key
npm run alerts         # what is broken and the command that fixes it; exit 1 if critical
npm run api            # Hono server on :8787
npm run dev            # api + Vite dev server (:5173, proxies /api to :8787)
npm run snapshot       # build web + render every API response into dist-cloudflare/
npm run cf:preview     # snapshot, then wrangler dev
npm run cf:deploy      # snapshot, then wrangler deploy — the ONLY way prod changes
```

Postgres and S3 contract tests run only when their env vars are set (each case gets its own schema / key prefix):

```bash
docker run -d --rm --name wd-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16   # Debian, not Alpine — see collation below
docker run -d --rm --name wd-s3 -p 59000:9000 -e MINIO_ROOT_USER=wdtest -e MINIO_ROOT_PASSWORD=wdtest-secret quay.io/minio/minio server /data   # Docker Hub's minio/minio is gone
WD_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres \
WD_TEST_S3_ENDPOINT=http://localhost:59000 WD_TEST_S3_ACCESS_KEY_ID=wdtest WD_TEST_S3_SECRET_ACCESS_KEY=wdtest-secret npm test
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
- **`npm run migrate` is rarely needed on its own.** `withStore()` in `ingest/src/cli.ts` calls `store.migrate()` on every CLI invocation, and the API calls it at boot, so `daily` applies a new column before the ingest that writes it. It exists as the explicit deploy step.
- **`npm run snapshot` needs `data/world.db`**, because it renders the real routes against the real database. It cannot run anywhere the 300 MB gitignored DB is absent — which is why there is no deploy-on-push.

CLI flags (ingest/backfill/doctor/score): `--only <id,id>`, `--since YYYY-MM-DD`, `--dry-run`, `--no-cache`, `--as-of YYYY-MM-DD` (point-in-time scoring, for backtests).

Logging is structured and goes to **stderr** — stdout stays the human report. `WD_LOG_LEVEL` (debug|info|warn|error|silent), `WD_LOG_FORMAT` (text|json, defaults to text on a TTY), `WD_LOG_FILE` (append). `npm test` silences it unless `WD_LOG_LEVEL` is already set.

## Architecture

npm workspaces, strict TypeScript, ESM + `NodeNext`. Dependency direction is one-way: `core ← store`, `core ← connectors`, and `ingest`/`api` on top. `@wd/core` has no database driver; `better-sqlite3` and `pg` live only in `@wd/store`. `web` depends on nothing internal and talks only to the HTTP API.

```
config/indicators.yaml   THE model — weights, thresholds, transforms. Not code.
packages/core/           types, Store interface, scoring, derived series, stats, quotes, board,
                         alerts (alerts.ts), logging (log.ts), MemoryStore (test double)
packages/store/          SqliteStore, PostgresStore, migrations.ts, copy.ts, createStore(),
                         cache.ts (FsCache, S3Cache, createCache — the raw response cache)
packages/connectors/     one module per upstream source, uniform Connector interface
packages/ingest/         CLI: migrate, doctor, ingest, backfill, derive, score, daily, health
packages/api/            Hono routes (routes.ts) + server.ts (Node) + snapshot.ts and
                         worker.ts (Cloudflare read path)
packages/web/            React + Vite, hash routing, hand-rolled SVG charts
wrangler.jsonc           Worker config: one ASSETS binding, no secrets, no nodejs_compat
data/world.db            local SQLite (gitignored); DATABASE_URL=postgres://… selects Postgres
dist-cloudflare/         generated snapshot — web bundle + api/*.json (gitignored)
```

**Everything is a time series.** Every connector — SDMX, ArcGIS, XML, CSV, JSON — normalises to `Observation { seriesId, obsDate, value }`. Storage, scoring, charting and staleness are written once, not once per source. Resist any design that needs a source-specific path through the pipeline.

**The pipeline** is ingest → derive → score. Connectors write raw series; `DERIVATIONS` in `core/src/derived.ts` compute analysis series from stored data (`d.*` ids); `core/src/scoring.ts` turns config-declared indicators into 0–100 stress scores, aggregates to pillars, then to a composite. `core/src/watchlist.ts` evaluates the depression precursors, which stay deliberately *outside* the weighted composite.

**Series-id namespaces** are by origin, not by pillar: `us.` `em.` `fx.` `metal.` `oil.` `gas.` `cmd.` `semi.` `mkt.` `crypto.` (connector-written), `ust.` (Treasury curve), and `d.` for everything derived. A `d.` id that no derivation produces silently scores nothing.

**Deployment is split, and the split is the thing to remember.** Cloudflare serves the **read path only**: a Worker (`api/src/worker.ts`) over a Static Assets bundle holding the web build plus one JSON file per API response. The **write path — ingest → derive → score — does not run on Cloudflare at all**; it is the same Node CLI on the local systemd timer (`scripts/install-timer.sh`), writing to the local `data/world.db`. This is fallback #2 from `docs/deploy-cloudflare.md` §7, taken because three free-plan limits (rows read per request, rows written per day, subrequests per invocation) rule out the on-platform pipeline in §2–§4.

Consequences worth holding in mind before changing anything:

- **A commit changes nothing in production.** There is deliberately no deploy-on-push: Workers Builds cannot run a build that needs the 300 MB gitignored `data/world.db`, and a commit is the wrong trigger anyway — the data changes daily, the code does not. `npm run cf:deploy` is the only thing that moves prod, and it must run somewhere the database exists. The README points at the systemd `ExecStartPost=` hook as the right place to automate it.
- **Prod freshness is downstream of the local timer.** A snapshot is only as current as the last `daily` run that fed it. If the timer is not firing, redeploying just republishes the same stale numbers.
- **`snapshot.ts` drives the real routes** through Hono's `app.request()`, so the published bytes are what `npm run api` serves by construction. Never reassemble a payload by hand there — that is a second implementation of the dashboard, and the one that drifts.
- **The Worker imports nothing.** No `@wd/core`, no Hono, hence no `nodejs_compat`. Keep it that way; it is what makes the bundle 2 KiB and free of Node built-ins.
- A new API route needs adding to `snapshot.ts`'s route list as well as to `routes.ts`, or it 404s in prod while working perfectly under `npm run api`.

**Ordering:** `DERIVATIONS` order is semantic — a derivation may read a series computed earlier in the same pass (`d.gold_breadth` needs the per-currency `d.gold.*` above it). The `CONNECTORS` registry order is cosmetic only; connectors run concurrently.

## Invariants worth knowing before editing

These are enforced by tests and by deliberate design; breaking one is usually a silent wrong answer rather than a crash.

- **Point-in-time scoring.** Only observations at or before the as-of date are visible, for both the current value *and* the distribution it is ranked against. `--as-of` backtesting is only honest because of this.
- **Missing beats wrong.** A stale input is dropped from scoring (not carried forward); a pillar below `MIN_PILLAR_COVERAGE` (0.34) is excluded from the composite (not averaged in); a watchlist item with missing inputs reports `unavailable` (never `clear`).
- **Staleness budgets come from publication lag, not cadence.** Observations are labelled at period start, so the newest observation's age *peaks just before the next release*: roughly `61 + D` days for a monthly series published on day D of the following month (95 for Core PCE and M2, 100 for the IMF metals panel, 105 for the trade balance), and ~320 for the two quarterly series that run a further quarter behind. Budgets tuned to cadence — or to an estimated rather than observed lag — flag healthy data as broken every single period. `connectors/src/catalog.test.ts` pins these.
- **A discontinued series is retired, not left to go stale.** `SeriesDef.retiredAt` (set from `retired:` in a connector catalogue) means the upstream will publish nothing further. Retired series are never fetched, never counted as stale, and excluded from the per-source stale denominator, but keep their history for `--as-of` backtests. The alternative is a warning that ages by a day every day and whose named fix cannot work, which is what trains a reader to ignore the alert list. It reached existing databases as migration 2 in `store/src/migrations.ts`.
- **`bands` vs `percentile` is a modelling decision, not a style choice.** Percentile cannot express non-monotonic risk (M2 growth and real yields are dangerous at *both* extremes) and degenerates on mostly-zero series (FIMA repo is zero in ~93% of weeks, so its median, p75 and p95 are all 0). Both cases must use `bands`.
- **Every score carries its arithmetic.** `ScoreRecord.inputs` and `IndicatorScore.explanation` are what make the model auditable in the UI. Never write a score without them.
- **Connector failures are isolated.** One broken feed must not abort the rest; every outcome including failure is written to `source_runs`, which is what the Sources tab reads.
- **A rate-limited source needs a backoff floor, not fewer retries.** `HttpOptions.minBackoffMs` holds a retry past the source's own interval; the default curve starts near 1s, so on GDELT the retry is refused too and spends another request being refused. GDELT additionally retries failed topics in a second pass after a cooldown, and only what fails *twice* becomes a warning — one throttled request must not mark the source `partial`, and because `TimelineVol` returns 12 months at once, a throttled topic writes nothing at all and is indistinguishable in the data from a dead feed.
- **Every pipeline stage records itself**, including when it throws. `runStage()` in `ingest/src/stage.ts` writes a `pipeline_runs` row on success, on partial failure and on exception (then re-raises, so the exit code still tells the scheduler). This is what catches the failure no per-source view can: an update that never ran leaves every source row as green as the day the scheduler died.
- **Alerts are computed, never stored.** `core/src/alerts.ts` turns runs + staleness + pillar coverage into a ranked list; the API and the CLI both call `collectAlerts`, so `npm run alerts` and the dashboard cannot disagree. Two rules: every alert names the command that fixes it, and a cause suppresses its symptoms (a failed source does not also raise a stale-series alert). A new alert kind belongs in `computeAlerts`, not in a route or a component.
- **Credentials are scrubbed twice.** `redactUrl()` handles URLs we build; `scrubSecrets()` in `log.ts` also blanks the literal value of any credential-shaped env var in every emitted line, which is what catches an upstream error quoting the key back at us.
- **The web bundle may outlive the API.** `withAlertDefaults` in `web/src/api.ts` fills fields an older server does not send — an ops feature must not be able to white-screen the page it was added to protect.
- **Schema changes are migrations, never hand edits.** Append a `Migration` to `MIGRATIONS` in `store/src/migrations.ts`; never edit or reorder one that has shipped (fix forward). Applied ids live in `schema_migrations`; Postgres takes `pg_advisory_lock` so the pre-deploy migrate and a cron run cannot race. Baseline (1) is all `IF NOT EXISTS`, which is how the pre-versioning `world.db` adopted it.
- **SQL stays portable, and the dialect differences are three type tokens.** `INSERT … ON CONFLICT DO UPDATE` only (never `INSERT OR REPLACE`), TEXT for dates, no extensions. Declare columns with `types(dialect)`: `ID` (AUTOINCREMENT vs IDENTITY), `FLOAT` (Postgres `REAL` is 4-byte and silently rounds), `TEXT` (`COLLATE "C"` on Postgres — a glibc/ICU locale ignores punctuation and sorts `us_a` before `us.a_b`, so every `ORDER BY id` would depend on how the host ran initdb). `MemoryStore` compares bytewise for the same reason; never `localeCompare` there.
- **Every `ORDER BY` needs a total order.** `daily` and the `ingest` it wraps share a start millisecond; GDELT stamps many events alike. Without an `id` tiebreak the two engines return ties in different orders — found by diffing a SQLite- and a Postgres-backed API over the real database, which is the check to repeat after touching a store (`copy-store` into a scratch Postgres, run both, compare every route).
- **A Postgres batch must not repeat a key.** `ON CONFLICT DO UPDATE` refuses to touch one row twice in a statement, where SQLite just overwrites. `PostgresStore` collapses each batch last-wins first (`lastWins`); keep that for any new bulk write.
- **Credentials never reach a log, an error or the DB.** `core/src/http.ts` `redactUrl()` strips key-ish query params; connector errors are persisted to `source_runs.error` and served by `/api/sources`.
- **The raw response cache is replayability, not performance.** It keeps verbatim upstream bodies so a parsing bug can be fixed and re-run against yesterday's exact bytes without burning a free-tier quota. `--no-cache` skips the read. It is a `ResponseCache` (`core/src/cache.ts`), **not part of `Store`**, and lives where `WD_CACHE_URL` says — `data/cache/` by default, an S3-compatible bucket in production (`S3Cache` signs with `aws4fetch`; keep it off the AWS SDK). `Http` treats a cache failure as a miss plus a warning; a dry run gets a `NullCache`; `daily` prunes past `WD_CACHE_RETENTION_DAYS`. Migration 3 dropped the old `raw_cache` table.
- **Quote arithmetic is server-side** in `core/src/quotes.ts` — change windows, 52-week range, 5-year percentile, sparkline. A change window shorter than the series' publication gap is omitted rather than forward-filled, and rate-like units report basis points, not a percent of a percent.
- **The API scores live from `config/indicators.yaml`** on each request; the `scores` table is only read for *history*. Editing weights shows up on refresh without re-running the scorer. **This holds for `npm run api` only.** The Cloudflare deployment serves a precomputed snapshot built by `npm run snapshot`, so there a weight edit changes nothing until `npm run cf:deploy` re-runs it, and `?as_of=` is ignored rather than honoured. Backtests are a local concern. See `docs/deploy-cloudflare.md` §5 and §11.
- **`WATCHLIST_SERIES` is duplicated** in `packages/api/src/routes.ts` and `packages/ingest/src/score.ts`. A new watchlist rule needs both lists updated or the API and CLI disagree.

## Adding things

**A data source:** write one module in `packages/connectors/src/` exporting a `Connector`, append it to `CONNECTORS` in `index.ts`. Nothing else changes. Declare series inline (connectors own their own metadata) and set `stalenessBudgetDays` from publication lag. Use the shared `util.ts` parsers — `num()` returns null rather than NaN for the many "no data" spellings, because NaN corrupts percentile ranks silently.

**An indicator:** commit `f668663` is the template to follow — connector catalog entry, `config/indicators.yaml` block with a justified transform, a test pinning the behaviour that would break if the transform were swapped, and a README line. Verify against live data at two dates (a quiet one and a known firing) before committing.

**A derived series:** add a `Derivation` to `DERIVATIONS`, positioned after anything it reads. Required `inputs` missing skips it with a warning; `optionalInputs` may be absent.

**A markets board row:** `core/src/board.ts`. Curation lives there because what belongs on a price board is a domain judgement, and the same list tells ingest what must stay fresh. `bp: true` is curated per row, not inferred from the unit — "percent" covers both yields (bp) and unemployment (not bp).

## Configuration and keys

Keys load from `.env.local`, then `.env`, and a real environment variable beats both (`FRED_API_KEY=x npm run ingest` always wins). Blank values are ignored. Everything runs keyless at roughly 40% coverage; `FRED_API_KEY` is by far the biggest unlock (the credit, real-economy and markets pillars are empty without it). Overrides: `WD_CACHE_URL` + `S3_*` (raw response cache, see above), `DATABASE_URL` (a `postgres://` URL selects Postgres; also accepts `sqlite:<path>`), `WD_DB_PATH`, `WD_CONFIG_PATH`, `PORT`. `DATABASE_URL` is scrubbed from logs like any credential, and any `scheme://user:pass@` in a line has its password blanked.

`loadScoringConfig()` validates strictly and throws — unknown pillar, non-positive weight, unsorted bands, duplicate series. That is intentional: a model that silently scores fewer inputs than you think is worse than one that refuses to start.

## Sources already evaluated and rejected

Do not re-attempt these; the README records why in full. **stooq** (JS proof-of-work challenge), **Yahoo Finance** (429s within a handful of requests, needs cookie+crumb), **Baltic Dry / Freightos / Drewry** (genuinely paywalled), **World Gold Council reserves** (login required — IMF SDMX is the open path and the obvious next connector). Silicon, polysilicon, cobalt, lithium and rare earths have no free reference price at all; the semiconductor panel approaches the chip cycle from four measurable angles instead of fabricating one.
