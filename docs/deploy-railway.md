# Deploying to Railway

**Target: Postgres + a separate cron service, ~$5–12/month on Hobby.**

This is a plan, not a changelog. Nothing here has been executed yet.

Railway has no free tier — Hobby is $5/month including $5 of usage. This
document exists to give the cost and the design decisions up front, not to
chase a free deployment the way the Cloudflare plan does.

---

## 1. Cost

An always-on API service, a Postgres instance, and a daily cron job land
around **$5–12/month** depending on Postgres storage and API traffic, on top of
the $5 Hobby subscription.

`deploy.sleepApplication` can put the API service to sleep between requests for
a personal dashboard with light traffic, trading a cold start (first request
after idle pays a few seconds) for lower usage cost. Worth enabling if the
dashboard is checked a few times a day rather than kept open.

---

## 2. Why Postgres, not SQLite on a volume

The obvious-looking shortcut — keep SQLite, mount a Railway volume, point
`WD_DB_PATH` at it — does not survive contact with the two-service split this
plan calls for.

**A Railway volume attaches to exactly one service.** A cron service and an API
service cannot share one SQLite file: at best you serialize the two into one
service (defeating the separation, and reintroducing "the API blocks on a
5-minute ingest run" as a real failure mode); at worst you point two services at
the same volume and get concurrent-writer corruption. Neither is acceptable for
a workload where the API needs to stay responsive while ingest runs.

Postgres, provisioned as its own Railway service, is what makes the split
possible — both the API and the cron service connect to it independently, no
shared filesystem required. This is also exactly the swap `core/src/store.ts`
was built for: the `Store` interface exists so a new backing store is a new
file, not a refactor of every call site.

---

## 3. Three services

Declared as infrastructure-as-code in `.railway/railway.ts`, reviewed, then
applied with `railway config apply`:

```ts
import { service, postgres } from "railway";

export const db = postgres("worldhealth-db");

export const api = service("worldhealth-api", {
  build: { buildCommand: "npm run build && npm -w @wd/web run build" },
  deploy: {
    startCommand: "node packages/api/dist/server.js",
    healthcheckPath: "/api/health",
  },
  variables: {
    DATABASE_URL: db.connectionString,
    WD_LOG_LEVEL: "info",
    WD_LOG_FORMAT: "json",
    FRED_API_KEY: "", // placeholder — set via `railway variables set`, never here
    EIA_API_KEY: "",
  },
});

export const cron = service("worldhealth-cron", {
  build: { buildCommand: "npm run build" },
  deploy: {
    startCommand: "node packages/ingest/dist/cli.js daily",
    cronSchedule: "20 7 * * *", // matches scripts/install-timer.sh's local 07:20
    restartPolicyType: "NEVER", // a cron job must exit, not restart on completion
  },
  variables: {
    DATABASE_URL: db.connectionString,
    WD_LOG_LEVEL: "info",
    WD_LOG_FORMAT: "json",
    FRED_API_KEY: "",
    EIA_API_KEY: "",
  },
});
```

Both app services reference the same `db.connectionString` — one Postgres
instance, two independent connections. `api` also builds and serves the web
bundle, matching `server.ts`'s existing "serve `packages/web/dist` if it
exists" behavior.

**Per the account's Railway gotchas** (see §7): define every variable — including
`FRED_API_KEY` and `EIA_API_KEY` as empty placeholders — at service-creation
time via the CLI, not later through the dashboard. Nobody should have to
discover a missing key by hitting a broken connector.

---

## 4. New code: `PostgresStore`

`packages/core/src/postgres-store.ts`, ~400 lines implementing the existing
`Store` interface over `pg`. `CLAUDE.md` states the SQL is portable to Postgres
already — this is *almost* true, and the plan needs to record exactly where it
is not, so the implementation doesn't discover it mid-migration.

### The portability gap

`packages/core/src/schema.ts` declares two tables with:

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
```

**This is SQLite-only.** D1 accepts it because D1 *is* SQLite under the hood;
Postgres does not have `AUTOINCREMENT`. `source_runs` and `pipeline_runs` are
the two tables affected. The fix is a dialect parameter in `schema.ts`:

```sql
-- SQLite / D1
id INTEGER PRIMARY KEY AUTOINCREMENT

-- Postgres
id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY
```

Also needed for Postgres: `REAL` → `DOUBLE PRECISION` (SQLite's `REAL` is fine
as an alias in Postgres, but `DOUBLE PRECISION` is the idiomatic form and avoids
relying on the alias). Everything else — `TEXT` for dates, `INSERT … ON CONFLICT
DO UPDATE`, the index definitions — is valid Postgres unchanged, which is what
lets `PostgresStore` be additive rather than a rewrite of `schema.ts`.

### Placeholder rewriting

SQLite (`better-sqlite3`) uses `?` positional placeholders; `pg` uses `$1`,
`$2`, .... This is purely a `PostgresStore` implementation concern — a small
rewrite helper or `$N`-native queries written directly in the new file. No other
package needs to know a placeholder style exists.

---

## 5. Data migration

A one-off script, `packages/ingest/src/migrate-store.ts`, opens both stores
(`SqliteStore` reading, `PostgresStore` writing) and streams every table across
in the order `schema.ts` declares them (foreign-key-free, so order only matters
for readability, not correctness).

**Skip `raw_cache`.** It is 185 MB of the local DB's 301 MB, and it refills
itself by design — the whole point of `raw_cache` is that it is replayability,
not data that must survive a migration (`CLAUDE.md`). Migrating it buys nothing
and roughly triples the transfer.

That leaves ~116 MB — 1,074,312 observations plus `series`, `source_runs`,
`pipeline_runs`, `series_health`, `scores`, `events`. Railway/Postgres has no
row-count caps analogous to D1's, so this is **one run taking a few minutes**,
not a multi-day drip.

---

## 6. Scheduling semantics

A Railway cron service runs the same container image on a schedule and must
**exit** when the work is done — hence `restartPolicyType: NEVER` above. Railway
watches the exit code; a non-zero exit is a failed run in Railway's own view,
same as it already is for the systemd timer.

This matches what the codebase already does. `runStage()` in
`packages/ingest/src/stage.ts` writes a `pipeline_runs` row on success, on
partial failure and on exception, then re-raises — so the exit code the
scheduler sees still tells the true story, and `npm run alerts` /
`collectAlerts` keep working completely unchanged. Nothing about the alerting
design needs to know it's running on Railway instead of a systemd unit.

---

## 7. Railway gotchas specific to this account

Incident-derived, from `~/.claude/skills/railway-local-gotchas` — each of these
has actually bitten this account and is not general Railway documentation:

- **Never `railway environment new <name> --duplicate <source>`.** It reuses the
  same underlying service IDs across environments — they are not isolated. If a
  staging environment is wanted later, create it fresh and add new services to
  it explicitly; do not duplicate.
- **The GitHub deploy-trigger branch binds to the service, not the
  environment.** If a service is ever shared across environments (e.g. by using
  `--duplicate` despite the warning above), changing the tracked branch for one
  environment silently changes it for every environment sharing that service.
  Verify with `railway status --json` per environment after connecting, don't
  assume a flag scoped correctly.
- **`railway domain` is not read-only.** Running it against a service with no
  domain yet generates and assigns one as a side effect. Don't run it during a
  "just checking" pass.
- **Custom-domain cert issuance is staged, not instant.** After `railway
  domain` and publishing the DNS records (CNAME + a separate
  `_railway-verify[.sub]` TXT — see `cloudflare-dns-ops`), the CNAME typically
  propagates within minutes but `certificate.status` moving off
  `VALIDATING_OWNERSHIP` can take minutes to a couple of hours. Check `railway
  domain status <domain> --json` rather than assuming a fresh publish means
  live; don't `curl -sI` a not-yet-issued cert and read anything into the result.
- **Rotating a credential (`DATABASE_URL`, an API key) on an environment already
  in use is a meaningful, hard-to-notice change** — don't do it on a vague
  "clean things up" instruction. Confirm the specific action, or confirm the
  environment is not yet live.
- **Destructive or credential-rotating commands require explicit user
  confirmation** — this account has the plugin's auto-approve hook disabled
  because it silently approved `service`/`environment delete` and `variables
  set`. That confirmation requirement is deliberate; don't route around it.

---

## 8. Cutover and rollback

1. Provision `worldhealth-db`, `worldhealth-api`, `worldhealth-cron` in a
   **staging** environment first — created fresh, not duplicated, per §7.
2. Run `migrate-store.ts` into staging's Postgres.
3. Run the cron service manually once (`railway run` or a manual trigger) and
   diff `/api/dashboard` against the local API's response — composite, every
   pillar score, every watchlist verdict must match.
4. Run both the Railway cron and the local systemd timer in parallel for a few
   days, diffing daily.
5. Promote: repeat the service setup in `production` (its own fresh services,
   not shared with staging), point DNS at it.

**Rollback is DNS plus re-enabling `scripts/install-timer.sh`.** The local
SQLite path and `--as-of` backtesting stay a local concern regardless of where
production runs.

---

## 9. What doesn't change

Unlike the Cloudflare plan, **nothing here breaks the "scores live from
`config/indicators.yaml` on each request" invariant.** Postgres has no read/write
row caps, `api` is a long-running Node process with no 10 ms CPU ceiling, and
`routes.ts`'s `loadSeries` — 127,192 rows per `/api/dashboard` call — runs
exactly as it does today. `--as-of` point-in-time scoring on demand also keeps
working unmodified. Railway costs more; in exchange, it costs nothing in
re-architecture.
