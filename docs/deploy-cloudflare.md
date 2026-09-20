# Deploying to Cloudflare

**Target: $0/month, entirely within the Workers free plan.**

This is a plan, not a changelog. Nothing here has been executed yet.

The README's earlier one-line target — *"Workers + D1 + Pages, with a Cron
Trigger replacing the systemd timer"* — is not achievable as written on the free
plan. Three separate limits block it, each independently fatal. This document
starts with that arithmetic, because it is what forces every design decision
that follows.

---

## 1. The budget, and the three blockers

### Published limits

| | Workers Free |
|---|---|
| Requests | 100,000 / day |
| **CPU time** | **10 ms per invocation** |
| Memory | 128 MB |
| **External subrequests** | **50 per invocation** (1,000 to Cloudflare services) |
| Cron Triggers | **5 per account** (not per Worker) |
| Cron wall-clock duration | 15 min |
| Static assets | 20,000 files / version, 25 MiB each |

| | D1 Free | R2 Free |
|---|---|---|
| Reads | 5,000,000 rows / day | 10M Class B ops / month |
| Writes | 100,000 rows / day | 1M Class A ops / month |
| Storage | 5 GB total | 10 GB-month |
| Egress | — | Free |

D1's daily row limits have been **hard-enforced since 2026-09-01** — queries now
fail with an error until midnight UTC, they do not merely warn. An index adds a
*second* written row for every insert that touches the indexed column.

### What this app actually does

| Measurement | Value | Source |
|---|---|---|
| Rows read per `/api/dashboard` | **127,192** across 55 series | `loadSeries` in `packages/api/src/routes.ts:70` calls `getObservations(id)` with no date bound |
| Rows rewritten per `derive` pass | **213,286** | `cli.ts` `daily` passes `since='1900-01-01'`, so every computed point is re-persisted every run |
| FRED external fetches per run | **~97** | one request per `CATALOG` entry, `packages/connectors/src/fred.ts:250-278` |
| Observations stored | 1,074,312 rows / 317 series | 213,286 of them derived |
| Local DB size | 301 MB | 185 MB of which is `raw_cache` (1,405 verbatim bodies) |
| Ingest window | ~16,630 obs/run | 120-day lookback across 287 series |

### The three blockers

1. **Reads.** 5,000,000 ÷ 127,192 = **39 dashboard loads per day** before D1
   starts returning errors. The `seriesCache` in `routes.ts` does not save this:
   on Workers it is per-isolate and short-lived, so most requests pay full price.
2. **Writes.** The derive pass alone is 213,286 rows against a 100,000/day cap —
   **2.1× over**, and 4.3× once `idx_obs_date` doubles it. Before ingest has
   written anything.
3. **Subrequests.** FRED makes ~97 external fetches in a single `run()`. The
   free cap is 50 per invocation.

On top of all three sits the **10 ms CPU ceiling**, which is the real binding
constraint and the one least amenable to a config change.

---

## 2. Architecture

```
Cron Trigger  * * * * *  ──▶  scheduler Worker
                                 │  read phase cursor from D1
                                 │  claim ONE work unit, run it, advance
                                 ▼
        ┌────────────┬──────────────┬─────────────┬──────────────┐
        │  ingest    │   derive     │   score     │   assemble   │
        │  shards    │   shards     │   shards    │   snapshot   │
        └────────────┴──────────────┴─────────────┴──────────────┘
                                 │
       D1  (small, relational)   │   R2  (bulk blobs)
       series                    │   obs/<series-id>.json   full history
       source_runs               │   cache/<key>            raw_cache
       pipeline_runs             │   snapshot/*.json        precomputed API
       series_health             │
       scores, events            │
       work_queue      (new)     │
                                 ▼
                    api Worker  +  Workers Static Assets
                    serves snapshot JSON + the web bundle
```

One Worker, two bindings, one Cron Trigger. The `api` and `scheduler` entry
points can live in the same Worker — `fetch` and `scheduled` handlers side by
side — which keeps it to a single deployment and a single cron trigger out of
the account's five.

---

## 3. Storage: D1 for relational, R2 for bulk

This is the central decision, and it is the one that departs from the README's
stated target. The reasoning is arithmetic, not taste.

### Why observations do not go in D1

Seeding the history D1 would need:

| Set | Rows | Row-writes (×2 for the index) | Days to seed at 100k/day |
|---|---|---|---|
| Hot set (scored ∪ watchlist ∪ board ∪ curve) — 152 series | 621,852 | 1,243,704 | **12.4** |
| Everything — 317 series | 1,074,312 | 2,148,624 | **21.5** |

There is no way around this. `wrangler d1 import` and the REST API are both
subject to the same daily cap — the enforcement changelog names the REST API
explicitly. A 12-day drip to seed a personal dashboard is not a reasonable
one-time cost, and it recurs in full any time the schema needs a rebuild.

The same history in R2 costs **317 Class A operations, once**, against a
1M/month allowance.

### Why R2 is also the cheaper choice on CPU

CPU is the binding constraint, and R2 wins there too. Reading one series as a
single ~112 KB JSON object and calling `JSON.parse` is far cheaper than
deserializing 8,000 individual D1 rows across the binding. With a 10 ms budget
per invocation, that difference decides whether a derive shard fits at all.

### The split

| Goes in D1 | Goes in R2 |
|---|---|
| `series`, `series_health` | `obs/<series-id>.json` — full history, one object per series |
| `source_runs`, `pipeline_runs` | `cache/<key>` — `raw_cache` bodies (185 MB) |
| `scores`, `events` | `snapshot/*.json` — the precomputed API payloads |
| `work_queue` (new) | |

All of it sits behind **one new `CloudflareStore` implementing the existing
`Store` interface** (`packages/core/src/store.ts`). The interface is already the
right shape — every method is async, which is exactly why this is a new file
rather than a refactor of every call site. Only `getObservations`,
`putObservations`, `cacheGet` and `cachePut` route to R2.

`raw_cache` in particular must not go to D1: each cached body would be a row
write, and the point of the cache is replayability, not performance
(`CLAUDE.md`). R2 gives it 10 GB and free egress.

### Steady-state D1 write budget

| | Rows | Row-writes |
|---|---|---|
| Ingest (120-day window, 287 series) | 16,630 | 33,260 |
| Derive (180-day window) | 4,078 | 8,156 |
| `series_health` + `source_runs` + `pipeline_runs` | ~340 | ~340 |
| Scheduler cursor (1,440 ticks/day) | — | ~1,440 |
| **Total** | | **~43,000 / day against 100,000** |

Comfortable, with the derive window as the tuning knob: a 400-day window costs
20,986 row-writes/day and still fits.

Reads collapse to near zero, because nothing scores live — see §5.

---

## 4. Sharding the pipeline

One work unit per cron invocation, each sized to stay under 10 ms CPU and 50
external subrequests.

### Connector partitioning

Add an optional method to the `Connector` interface
(`packages/core/src/connector.ts`):

```ts
/** Independent units of work, for hosts with a per-invocation fetch budget.
 *  Absent means one partition: the whole run(). */
partitions?(ctx: FetchCtx): string[];
```

`run()` receives the partition key via `ctx`. FRED implements it, returning its
97 catalog entries in chunks of ~5 → **~20 units**. Connectors already under the
limit — `ecb-fx` (1 fetch), `coingecko` (4), `lbma-metals` — change not at all.
This preserves the invariant that adding a source means writing one module and
appending it to `CONNECTORS`.

**Audit every connector's fetch count before building.** Candidates above the
line: `treasury-curve` (one request per year — 25 on a backfill), and the
pagination loops in `eia`, `portwatch`, `gdelt`, `treasury-auctions` and `bis`.
Partition anything above ~40.

### Derive sharding

One `Derivation` per invocation, reading only its declared `inputs` from R2.

**`DERIVATIONS` order is semantic** (`CLAUDE.md`: `d.gold_breadth` reads the
per-currency `d.gold.*` series computed above it). The queue must preserve it —
a derivation cannot be claimed before its predecessors are marked done. This is
the one place where naive parallelism produces a silent wrong answer rather than
a crash.

### Bounding the derive window

`daily` currently recomputes and re-persists all history. `deriveAll` already
filters with `points.filter(p => p.obsDate >= since)`, so this is a
**one-argument change at the call site** in `packages/ingest/src/cli.ts`, not a
rewrite:

```ts
// was: deriveAll(store, '1900-01-01')
await deriveAll(store, addDays(todayIso(), -180));
```

Full-history recompute stays available as an explicit
`derive --since 1900-01-01`, which is what you run after fixing a derivation bug.

### Score sharding

Nine pillar shards, each reading only its own indicators and writing a partial
to R2; a final assembler merges them into the snapshot.

### The scheduler

A **single** Cron Trigger at `* * * * *`, driving a phase state machine in a new
D1 `work_queue` table — not five separate triggers, because the free plan's five
are an **account-wide** budget shared with everything else you run.

Roughly 96 work units per day (≈20 FRED + ≈15 other connector partitions + 51
derive + 9 score + 1 assemble) drains in about 1.6 hours. An idle tick costs one
D1 read and effectively no CPU. 1,440 invocations/day against a 100,000 cap.

---

## 5. What this breaks

`CLAUDE.md` records an invariant:

> **The API scores live from `config/indicators.yaml`** on each request; the
> `scores` table is only read for *history*. Editing weights shows up on refresh
> without re-running the scorer.

**This is not possible on the Workers free plan.** Live scoring means 127,192
row reads and tens of milliseconds of CPU per request, against caps of
5M rows/day and 10 ms. On Cloudflare the API serves a **precomputed snapshot**,
and a weight edit requires a re-run of the scorer.

The mitigation is that scoring is idempotent and cheap to re-trigger, so "edit
weights, re-run, refresh" is a few seconds rather than instant. When this
migration is executed, `CLAUDE.md` must gain this caveat next to the invariant —
an invariant that is true locally and false in production is worse than no
invariant.

Also lost: `?as_of=` point-in-time scoring on demand. Backtests stay a local
concern, which is where they belong.

---

## 6. Node-only code to port

Small and contained. The Hono choice pays off here: `packages/api/src/routes.ts`
needs no changes at all.

| File | Issue | Fix |
|---|---|---|
| `core/src/config-loader.ts` | `readFileSync` | split `parseScoringConfig(text)` (pure) from `loadScoringConfig(path)` (Node wrapper); bundle the YAML via a wrangler `Text` module rule |
| `core/src/log.ts` | `node:fs` for `WD_LOG_FILE` | lazy-import the file sink so the Workers build never pulls `node:fs` |
| `core/src/http.ts` | `node:crypto` `createHash` | works under `nodejs_compat` — keep it, `cacheKeyFor` is sync |
| `core/src/sqlite-store.ts` | `better-sqlite3` | untouched; `CloudflareStore` sits beside it |
| `ingest/src/runner.ts` | reads `process.env` directly | take env from `ctx` |
| `connectors/src/index.ts` | `connectorHealth(env = process.env)` | already parameterised — pass `env` explicitly |
| `api/src/server.ts` | Node entry point | a Workers entry replaces it |

---

## 7. Step 1 is a measurement gate, not a build

**Do not build any of the above until the CPU assumption is tested.**

Deploy a throwaway probe Worker that runs, one per invocation:

1. one FRED partition (5 series: fetch, parse, R2 write)
2. one derive unit (load inputs from R2, compute, write)
3. one pillar score (percentile ranks across its indicators)

Read the actual cost from `wrangler tail --format json` — each tail event carries
`cpuTime` — or from Workers Analytics.

- **All three under ~7 ms** → proceed; the margin absorbs runtime variance.
- **Any unit over** → shrink the partition (3 FRED series instead of 5, one
  indicator per score shard) and re-measure.
- **Still over after shrinking** → the free plan is out of reach for that stage.
  Two documented fallbacks:
  - **Workers Paid**, $5/mo: 5 min CPU, 10,000 subrequests. Every blocker above
    evaporates and the design collapses back to the README's original target.
  - **Pipeline off-platform**: GitHub Actions runs the existing Node CLI
    unchanged on a cron, state in R2, publishing snapshots and the web bundle via
    `wrangler deploy`. Cloudflare serves the read path only. Still $0, no
    sharding, no connector refactor — but the pipeline no longer lives on
    Cloudflare.

---

## 8. Configuration

### `wrangler.jsonc`

```jsonc
{
  "name": "worldhealth",
  "main": "packages/api/src/worker.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],

  // Assets are served without invoking the Worker, and do not count
  // against CPU. The web bundle is ~a dozen files, far under 20,000.
  "assets": { "directory": "packages/web/dist", "binding": "ASSETS" },

  "d1_databases": [
    { "binding": "DB", "database_name": "worldhealth", "database_id": "<id>" }
  ],
  "r2_buckets": [
    { "binding": "BLOBS", "bucket_name": "worldhealth" }
  ],

  // One trigger. The free plan allows five per ACCOUNT, shared with
  // everything else you run.
  "triggers": { "crons": ["* * * * *"] },

  // config/indicators.yaml as a bundled text module — there is no
  // filesystem to readFileSync from.
  "rules": [
    { "type": "Text", "globs": ["**/*.yaml"], "fallthrough": true }
  ],

  "observability": { "enabled": true }
}
```

### Secrets

Run these yourself — credentials are provisioned inside the CLI and never
handled by an agent or committed:

```bash
wrangler secret put FRED_API_KEY
wrangler secret put EIA_API_KEY
```

`redactUrl()` and `scrubSecrets()` already keep keys out of logs, errors and the
DB (`CLAUDE.md`); nothing about that changes on Workers.

### Serving notes

Snapshot responses carry `Cache-Control` so the edge absorbs repeat reads and
the Worker is barely invoked. **This requires a custom domain** — `workers.dev`
does not apply CDN caching to Worker responses. Route the zone's DNS through
`cf-dns` (`cloudflare-dns-ops`).

---

## 9. Cutover and rollback

1. Seed R2 from the existing `data/world.db` — 317 `PUT`s, one per series.
   Skip `raw_cache`; it refills itself by design.
2. Run the Cloudflare pipeline **in parallel** with the systemd timer for a few
   days. Both are idempotent and write to different stores.
3. Diff the snapshot against the local API's `/api/dashboard` daily. The
   composite, every pillar score and every watchlist verdict must match.
4. Cut DNS.

**Rollback is DNS plus re-enabling the systemd timer.** Keep `scripts/install-timer.sh`
and the SQLite path working for exactly this reason — and because backtests
(`--as-of`) stay a local concern regardless.

---

## 10. Cost

**$0/month**, if the measurement gate in §7 passes: Workers free, D1 free
(~43k of 100k daily writes, near-zero reads), R2 free (~200 MB of 10 GB,
operations three orders of magnitude under the caps).

The only spend decision is the §7 fallback: **$5/mo for Workers Paid** buys back
live scoring, the full-history derive pass, and the deletion of every shard in
§4. If the sharded design proves fragile in practice, that is the trade to make.
