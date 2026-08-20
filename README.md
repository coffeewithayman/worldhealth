# World Dashboard

Daily-updating dashboard for global economic health, read through a **sound-money**
lens, built to surface the early signs of a **depression** rather than an ordinary
recession.

That distinction drives every design decision. Conventional dashboards track GDP and
unemployment, which are lagging and heavily revised. The signals that preceded 1929,
1937 and 2008 were monetary and credit-market signals: currency debasement, credit
spread blowouts, bank credit contraction, failing sovereign debt auctions, collapsing
physical trade, and a flight into hard money. So this measures things against gold and
real rates, treats monetary expansion as a symptom rather than a cure, and watches the
plumbing — repo, swap lines, auction takedown, chokepoint tonnage — rather than the
headline prints.

Alongside the stress model there is a **markets board**: seven curated price panels
covering currencies, precious metals, the industrial and chip-input metals, the
semiconductor complex, energy, rates and credit, and equities and crypto. Every row
carries its move over five windows, its position inside the last 52 weeks, its rank
in its own five-year distribution, and a one-year sparkline.

---

## Quick start

```bash
npm install
npm run build

cp .env.example .env.local   # optional but strongly recommended — see "API keys"

npm run migrate           # create the SQLite schema
npm run backfill          # load deep history (needed for percentile scoring)
npm run daily             # ingest → derive → score

npm run api               # http://localhost:8787
```

`npm run dev` runs the API and the Vite dev server together with hot reload.

Without any API keys you get roughly 40% coverage from the keyless sources. With a
free FRED key you get most of it. The dashboard is explicit about which pillars are
thin rather than quietly averaging over the gaps.

---

## The dashboard

Four tabs, and every view is deep-linkable through the URL hash — a panel nobody
can link to is a panel nobody cites.

| Route | What |
|---|---|
| `#/` | **Overview.** Composite stress as a gauge with its band scale, the financial-core price strip, the eleven depression precursors (triggered first), and the nine pillar scores |
| `#/markets/<board>` | **Markets.** The seven price boards: `fx`, `precious`, `chipmetals`, `semis`, `energy`, `rates`, `markets`. Sortable, filterable, with the Treasury curve under the rates board |
| `#/pillar/<pillar>` | **Pillar drill-down.** The score as a gauge, a ranked "what is driving it" contribution breakdown, and one card per indicator showing its reading, transform and arithmetic |
| `#/series/<id>` | **Series drill-down.** Stat tiles, a full-history chart with range selection, why the series is carried, and its complete provenance |
| `#/events`, `#/sources` | The news event feed, and per-feed health with last-run status |

Light and dark themes are both explicitly designed rather than inverted, and the
toggle in the header wins over the OS setting in both directions.

### API

| Endpoint | Returns |
|---|---|
| `GET /api/dashboard` | Composite, pillars, watchlist, score history, feed health |
| `GET /api/markets` | Every board row with changes over seven windows, 52-week range, five-year percentile, sparkline, and the Treasury curve today / 1mo / 1y ago |
| `GET /api/pillar/:pillar` | Indicators with score arithmetic, contribution share and sparklines |
| `GET /api/series/:id` | Metadata, health, quote statistics and the full observation history |
| `GET /api/events`, `GET /api/sources`, `GET /api/health` | Event feed, feed health, liveness |

Two presentation rules are enforced in the data layer rather than left to the
component: a change window shorter than the series' publication gap is **omitted**
instead of forward-filled (so a monthly series shows no one-day move), and rate-like
units report **basis points** rather than a percent change of a percent.

---

## API keys

Every key is free and none require a card. `npm run sources` lists which connectors
are currently disabled for want of one.

Keys are read from `.env.local` first, then `.env`, and a real environment variable
beats both — so `FRED_API_KEY=x npm run ingest` always wins. Both files are
gitignored; blank values are ignored, so a placeholder left over from
`.env.example` in one file will not mask a real key in the other. Put your own
keys in `.env.local`.

| Key | Cost | Unlocks | Get it |
|---|---|---|---|
| `FRED_API_KEY` | free | **The single biggest unlock** — credit spreads, repo rates, swap lines, M2, bank credit, Sahm rule, claims, housing, VIX. Without it the credit, real-economy and markets pillars are empty. | [fredaccount.stlouisfed.org/apikeys](https://fredaccount.stlouisfed.org/apikeys) |
| `EIA_API_KEY` | free | Crude and distillate inventories, refinery utilisation, SPR, daily electricity demand. | [eia.gov/opendata/register.php](https://www.eia.gov/opendata/register.php) |
| `COINGECKO_API_KEY` | free tier | Higher rate limit and history beyond ~365 days. The connector works without it. | [coingecko.com/en/api](https://www.coingecko.com/en/api/pricing) |

---

## Commands

| Command | What it does |
|---|---|
| `npm run migrate` | Apply the database schema |
| `npm run sources` | List connectors and their key status |
| `npm run doctor` | Probe every source without writing — fastest way to spot a missing key or a changed upstream API |
| `npm run ingest` | Incremental fetch (last 120 days, absorbing revisions) |
| `npm run backfill` | Deep history load (default 25 years) |
| `npm run score` | Recompute composite, pillar and watchlist scores |
| `npm run daily` | **ingest → derive → score** — the scheduler entrypoint |
| `npm run api` | Serve the API and the built dashboard |
| `npm run dev` | API + Vite dev server with hot reload |
| `npm test` | Transform, scoring and watchlist tests |

Useful flags: `--only <id,id>`, `--since YYYY-MM-DD`, `--dry-run`, `--no-cache`,
and `--as-of YYYY-MM-DD` to score a past date point-in-time.

### Daily scheduling

```bash
./scripts/install-timer.sh
```

Installs a systemd **user** timer running `npm run daily` at 07:20 with catch-up
for missed runs. Chosen over crontab because output lands in the journal,
`systemctl --user status` shows whether the last run actually succeeded, and
`Persistent=true` fills a run missed while the machine was off — a skipped day
leaves a permanent hole in the score history.

For timers to fire while you are logged out: `sudo loginctl enable-linger $USER`.

---

## How the score works

Deliberately simple and fully auditable — an opaque model here would be worse than
no model. The UI shows the arithmetic behind every number.

**1 — Each indicator maps to a 0–100 stress score** via one of three transforms,
declared per indicator in `config/indicators.yaml`:

- `percentile` — rank against its own trailing history. Right for spreads and ratios
  with no natural threshold.
- `zscore` — standard deviations from the trailing mean, clamped. Right for roughly
  stationary series.
- `bands` — piecewise-linear interpolation through explicit control points. Right
  where history is thin or misleading and the thresholds that matter are known.
  Bands also express **non-monotonic** risk, which matters more than it sounds: for
  M2 growth and real yields *both* extremes are dangerous — contraction signals
  depression, explosion signals debasement. A percentile rank cannot represent that
  and would score runaway money printing as maximally safe.

  Bands are also the answer for **mostly-zero emergency facilities**. FIMA repo usage
  is zero in ~93% of weeks, so its median, p75 and p95 are all 0 — a percentile rank
  against that history is arithmetic noise. Bands score it against the magnitudes that
  actually mean something instead.

**2 — Pillar score** is the weighted mean of its indicators, with **coverage**
tracked. A pillar assembled from a small fraction of its intended inputs is not a
measurement, so below 34% coverage it is excluded from the composite rather than
averaged in misleadingly.

**3 — Composite** is the weighted mean of qualifying pillars.

**4 — Regime** uses the count of elevated pillars alongside the composite level.
Breadth of stress is what separates a sector problem from a systemic one, so five
stressed pillars reads as Crisis even if the weighted average is unremarkable.

**Weights and thresholds live in `config/indicators.yaml`, not in code** — tune the
model by editing YAML. The loader validates strictly and fails loudly, because a
model that silently scores fewer inputs than you think is worse than one that
refuses to start.

Scoring is **point-in-time**: only observations at or before the as-of date are used,
for both the current value and the distribution it is ranked against. That is what
makes `--as-of` backtesting honest.

### Depression Precursor Watchlist

Ten signals kept deliberately *outside* the weighted composite, because averaging
destroys exactly the information they carry — each is individually rare and
individually meaningful.

1. Deep yield-curve inversion now **re-steepening** (the trigger is the un-inversion, not the inversion)
2. High-yield spreads above 800bp **and widening**
3. **M2 contracting year-over-year** — has happened in the 1930s and 2023, essentially nowhere else
4. Bank credit contracting
5. Sahm rule triggered
6. Central bank dollar swap lines drawn
7. Treasury auction dealer takedown at extremes
8. EM sovereign spreads blowing out
9. Repo trading above IORB
10. **Gold at 1-year highs against nearly all currencies** — a monetary event, not a commodity rally

Each reports **unavailable** rather than **clear** when its inputs are missing. A
signal that cannot be evaluated must never render as a signal that is quiet.

---

## Data sources

~180 raw series plus ~50 derived, across nine pillars.

### Keyless

| Source | What | Notes |
|---|---|---|
| **US Treasury** | Full daily par yield curve, back to 1990 | Direct from Treasury, no key |
| **Treasury FiscalData** | **Auction bid-to-cover, dealer takedown, indirect share** | Highest-signal source here and almost nobody charts it — see below |
| **ECB** | Daily reference rates, ~27 currencies, back to 1999 | The FX backbone; very reliable |
| **LBMA** | Gold, silver, platinum, palladium benchmarks in USD/GBP/EUR, **back to 1968** | Better than any paid metals API, and free |
| **IMF PortWatch** | Daily transits and tonnage through 11 maritime chokepoints, from satellite AIS | Daily granularity, **refreshed weekly (Tuesdays)** |
| **BIS** | Real residential property prices and credit-to-GDP gaps, 18 economies | Quarterly, published with a lag |
| **GDELT** | News event feed + narrative intensity as a scoreable series | Rate limited to 1 req/5s; a full pass takes ~2 min |
| **CoinGecko** | Bitcoin, and **stablecoin supply** as an offshore dollar-demand proxy | Works without a key |

### Keyed

| Source | What |
|---|---|
| **FRED** | ~87 series: credit spreads, repo, swap lines, **FIMA repo facility usage**, money supply, labour, housing, volatility, IMF industrial-metal benchmarks, and the semiconductor complex |
| **EIA** | Crude/distillate/gasoline stocks, SPR, refinery utilisation, **daily electricity demand** |

### Metals and the chip supply chain

The metals panel covers the physical inputs the silicon supply chain runs on:
copper (interconnect and power delivery), tin (solder), aluminium (packaging and
heat spreaders), nickel (capacitor electrodes and barrier layers), zinc, lead, iron
ore, and uranium for the baseload a fab burns — plus the LBMA precious metals, of
which silver and palladium are themselves chip inputs (conductive paste, MLCC
terminations).

These come from the IMF primary-commodity panel via FRED and are **monthly**. That
is the honest ceiling: the daily benchmark for every one of them is LME or
Fastmarkets pricing, which is licensed and not free. The UI labels the cadence and
suppresses the one-day and one-week columns rather than forward-filling a monthly
value and presenting it as a daily move.

**Silicon, polysilicon, cobalt, lithium and the rare earths have no free reference
price at all.** Rather than fabricate one, the semiconductor panel approaches the
chip cycle from four measurable angles — the PHLX Semiconductor index (daily,
market-priced), semiconductor physical production, chip producer prices, and new
orders for computers and electronics — with a listed lithium-miner index carried
explicitly as a *proxy*, labelled as such, to be read for direction only.

### Four sources worth singling out

**Treasury auction takedown.** A government funding itself is the load-bearing
assumption under the whole financial system, and auctions test it in public twice a
week. Primary dealers are *obligated* to bid, so they absorb whatever real buyers
decline — a rising dealer share means genuine demand is failing, and it shows up
well before yields visibly break. This is the quantitative early form of a "failed
auction".

**FIMA repo facility.** The pressure-relief valve on the same pipe. A foreign central
bank that needs dollars can either sell Treasuries outright — pushing US yields up —
or pledge them at the Fed and borrow against them. Usage is therefore the *quiet*
form of foreign Treasury stress, visible weekly with a one-day lag, where TIC reports
the same event as a holdings drop roughly six weeks later. It sat at zero for years,
then went to $60bn in the SVB / Credit Suisse week of March 2023 and back to zero.
Scored with `bands` rather than percentiles for the reason described above.

**Maritime chokepoints.** Financial data can be managed, smoothed and revised; ships
either transit the Strait of Hormuz or they do not. The dashboard pairs Suez with
the Cape of Good Hope specifically to separate *rerouting* from *collapse* — when
Red Sea attacks closed Suez in early 2024, Suez transits fell 76→41 per day while
the Cape rose 50→91, showing cargo was sailing around Africa rather than stopping.
A fall in Suez *without* a rise at the Cape would be the genuinely alarming case.

**Gold priced in every currency.** Gold rising against one currency is that country's
problem. Gold at one-year highs against nearly all of them simultaneously means the
fiat system as a whole is being repriced. The breadth measure validates cleanly
against history — it fires in 2008, 2011, 2019, 2020 and 2024-25.

### Sources evaluated and rejected

Recorded so they are not re-attempted:

- **stooq** — now serves a JavaScript proof-of-work challenge to non-browser clients.
  Unusable for automation.
- **Yahoo Finance** — the undocumented chart endpoint rate-limits to HTTP 429 within a
  handful of requests and now requires a cookie+crumb session. Too fragile for a daily
  unattended job; FRED covers the same US market series reliably.
- **Baltic Dry / Freightos FBX / Drewry WCI** — genuinely paywalled. The free-API
  claims found online route through resellers. PortWatch, plus EIA electricity demand,
  carry the physical-activity signal instead.
- **World Gold Council** central bank gold reserves — requires a login. IMF SDMX
  (`api.imf.org/external/sdmx/3.0`, dataflows `IL` and `COFER`) is the open path and
  is the obvious next connector to add.

---

## Architecture

```
config/indicators.yaml     THE model — weights, thresholds, transforms
packages/
  core/         types, Store interface, scoring engine, derived series, stats,
                quote statistics (quotes.ts) and the markets board (board.ts)
  connectors/   one module per source, uniform interface
  ingest/       CLI: migrate, doctor, ingest, backfill, derive, score, daily
  api/          Hono API — runs on Node now, Workers later unchanged
  web/          React + Vite dashboard, hand-rolled SVG charts
data/world.db   SQLite (gitignored)
```

**Everything is a time series.** Every connector, whatever its wire format (SDMX,
ArcGIS, XML, CSV, JSON), normalises to `(series_id, date, value)`. Storage, scoring,
charting and staleness are then written once rather than once per source.

**Adding a source** means writing one module and appending it to the registry in
`packages/connectors/src/index.ts`. Nothing else changes.

**Connector failures are isolated.** One broken feed must never abort the other
thirty. Every outcome — including failure — is written to `source_runs`, which is
what the Sources tab reads.

**Quote arithmetic happens server-side.** Changes over seven windows, the 52-week
range, the five-year percentile and the sparkline are all computed in
`packages/core/src/quotes.ts` and shipped ready to render. The alternative — sending
decades of observations for a hundred rows and recomputing on every render — is both
slower and impossible to unit-test.

**`raw_cache` is not a performance optimisation.** It stores verbatim upstream
responses so a parsing bug found on Tuesday can be fixed and re-run against Monday's
exact bytes without burning a rate-limited quota.

### Deploy later

The build is local-first but structured so hosting is a swap, not a rewrite:

- All database access goes through the `Store` interface in `packages/core`. The
  SQLite implementation is one file; D1 or Postgres is a second file.
- SQL is deliberately portable — `INSERT … ON CONFLICT DO UPDATE` only, valid in
  SQLite, Postgres and D1. No SQLite extensions.
- The API is Hono, which runs unmodified on Node and on Cloudflare Workers.
- Every `Store` method is async even though SQLite is synchronous, so call sites
  already await.

Target shape on Cloudflare: Workers + D1 + Pages, with a Cron Trigger replacing the
systemd timer.

---

## Staleness

You opted out of notifications, so **staleness is surfaced in the UI instead**: a
banner on the overview, per-source counts on the Sources tab, and age badges on
individual series. Every series carries a `stalenessBudgetDays` set from its
*publication lag*, not its cadence.

The budget has to cover a full period **plus** the label offset plus the release
lag, because observations are labelled at period *start*. A monthly series labelled
`2026-06-01` is the newest available until mid-August, so anything under ~80 days
flags healthy data as broken for half of every month; quarterly bank call-report
data labelled `2026-01-01` needs ~260. Budgets tuned to cadence alone are the reason
a staleness banner stops being read.

A stale series is dropped from scoring rather than treated as current, and counted
against its pillar's coverage. The failure mode this prevents is the one that could
actually cost money: a dead feed quietly showing months-old numbers as if they were
today's.

---

## Testing

```bash
npm test        # 33 tests: transforms, point-in-time discipline, aggregation,
                #           watchlist, quote statistics, board integrity
npm run doctor  # probe every upstream source, write nothing
```

The tests that matter most assert the properties that are easy to get quietly wrong:
that scoring never sees data after the as-of date, that a stale input is dropped
rather than scored, that an under-covered pillar is excluded rather than averaged,
and that a watchlist item with missing inputs reports *unavailable* rather than
*clear*.
