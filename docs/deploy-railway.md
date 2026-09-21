# Deploying to Railway

**Production: one Docker image, two services, Postgres, and an S3 bucket.
Merging to `main` is the deploy.** Roughly $5–12/month on the Hobby plan.

```
               ┌──────────────────────────── one image (Dockerfile) ───────────────────────────┐
push to main → │ worldhealth-api   railway.api.toml   pre-deploy: migrate → server.js  /healthz │
               │ worldhealth-cron  railway.cron.toml  20 7 * * * UTC: daily, then exit          │
               └────────────────────────────────────────────────────────────────────────────────┘
                          │ DATABASE_URL                         │ WD_CACHE_URL + S3_*
                   worldhealth-db (Postgres)             worldhealth-cache (bucket: raw responses)
```

After the one-time setup below, nothing in production is edited by hand:

| Change | How it reaches production |
|---|---|
| Code, weights in `config/indicators.yaml` | Merge → both services rebuild from the new commit |
| Schema | A new entry in `packages/store/src/migrations.ts` → applied by the API's pre-deploy `migrate` before the release takes traffic (and by every CLI run, under an advisory lock) |
| A new data source or catalogue entry | Merge → the next `daily` ingests it and backfills its 25-year history on its own (`series_backfill`) |
| API keys | Railway service variables — the only thing that is not in git |

---

## 1. Why this shape

- **Postgres, not SQLite on a volume.** A Railway volume attaches to exactly one
  service. The API and the cron job are two services, so they need a database
  both can reach over the network.
- **The raw response cache in a bucket, not the database.** Upstream bodies
  were ~60% of the old SQLite file, are rarely read, and refill themselves.
- **Two services from one image**, told apart only by start command. The cron
  service runs, exits, and waits for the next firing; a non-zero exit is a failed
  run in Railway's view, the same verdict `pipeline_runs` records.
- **The API still scores live** from `config/indicators.yaml` on each request, and
  `?as_of=` backtests work in production, unlike the retired Cloudflare snapshot.

## 2. Portability

Nothing in the application knows it is on Railway. Everything platform-specific
is in `Dockerfile` (generic) and `railway.*.toml` (Railway's). Another host needs:

1. The same image, run twice: `node packages/api/dist/server.js` (serve, health
   check `GET /healthz`) and `node packages/ingest/dist/cli.js daily` (once a day).
2. `node packages/ingest/dist/cli.js migrate` before each API release (optional:
   every command migrates on start anyway).
3. The variables in §4.

Fly (`fly.toml` + a scheduled machine), Render (web service + cron job), a VPS
(`docker compose` + a systemd timer or crontab), or Kubernetes (Deployment +
CronJob) all map onto those three lines. `docker-compose.yml` is a working
local example of the whole topology, including an S3-compatible store (MinIO).

## 3. One-time setup

Provisioning is done through the Railway CLI or dashboard, once, in a **fresh**
environment (never `railway environment new --duplicate`; see §7).

1. Create the project and a **Postgres** service (`worldhealth-db`).
2. Create a **Bucket** (`worldhealth-cache`), or use any S3-compatible bucket
   (R2, S3). Note its endpoint and credentials.
3. Create **`worldhealth-api`** from the GitHub repo, branch `main`.
   Settings → Config-as-code → `railway.api.toml`. Generate a domain.
4. Create **`worldhealth-cron`** from the same repo and branch.
   Settings → Config-as-code → `railway.cron.toml`. No domain.
5. Set the variables in §4 on both app services.
6. Enable "Wait for CI" on both, so a red GitHub Actions run blocks the deploy.
7. Load history (§5), or let the first `daily` backfill from nothing.

## 4. Variables

Set on **both** `worldhealth-api` and `worldhealth-cron`. Reference variables
(`${{…}}`) keep them in step with the services they point at.

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{worldhealth-db.DATABASE_URL}}` |
| `WD_CACHE_URL` | `s3://<bucket>/raw` |
| `S3_ENDPOINT` | the bucket's endpoint, e.g. `${{worldhealth-cache.ENDPOINT}}` |
| `S3_ACCESS_KEY_ID` | `${{worldhealth-cache.ACCESS_KEY_ID}}` |
| `S3_SECRET_ACCESS_KEY` | `${{worldhealth-cache.SECRET_ACCESS_KEY}}` |
| `S3_REGION` | the bucket's region (`auto` for R2); defaults to `us-east-1` |
| `S3_URL_STYLE` | `virtual` only if the store rejects path-style URLs |
| `FRED_API_KEY` | required for most of the model |
| `EIA_API_KEY` | energy panel |
| `COINGECKO_API_KEY` | optional |
| `WD_CACHE_RETENTION_DAYS` | optional, default 30 |

The exact bucket variable names depend on the bucket product; check them on the
bucket service and map them onto the `S3_*` names above. The application reads
only the `S3_*` names (or `AWS_*` equivalents), so a change of provider is a
change of variables, not code. `DATABASE_URL` and every `*_KEY`/`*SECRET*` value
is scrubbed from logs.

## 5. Loading the existing history

`copy-store` copies a local SQLite database into Postgres: every table except the
old raw cache, including `series_backfill`, so production does not re-backfill
what it already has. Rows already in the target are left alone, so a re-run
after production has started writing never overwrites newer data.

```bash
# the database's public URL: worldhealth-db → Connect → Public network
DATABASE_URL='postgres://…' npm run copy-store -- --from data/world.db
```

1.08M observations copy in about 25 seconds from a local machine to a local
Postgres; over the internet expect a few minutes.

Skipping this step is also valid: an empty database fills itself on the first
`daily` (every series is un-backfilled, so each gets its 25 years). That takes
longer and spends upstream quota; the copy is faster for the initial load.

## 6. Operating it

- **Is it up?** `GET /healthz` (process and database), `GET /api/health`
  (the data: alert summary and last pipeline run). The dashboard's alert list
  and `npm run alerts` read the same computation.
- **Run the pipeline now:** Railway → `worldhealth-cron` → Deployments → Run now,
  or `railway run --service worldhealth-cron node packages/ingest/dist/cli.js daily`.
- **Logs** are JSON lines (`WD_LOG_FORMAT=json` in the image).
- **Rollback** is Railway's redeploy of the previous deployment. Migrations are
  forward-only, so a rollback past a migration runs old code against a newer
  schema: write migrations additively (new columns nullable, no drops of
  anything the previous release reads) and drop in a later release.
- **Backtests** (`--as-of`) work against production (`?as_of=` on the API) and
  locally against a `copy-store`d or SQLite database.

## 7. Railway gotchas specific to this account

Incident-derived, from `~/.claude/skills/railway-local-gotchas`:

- **Never `railway environment new <name> --duplicate <source>`.** It reuses the
  same underlying service IDs across environments. Create a staging environment
  fresh and add services to it explicitly.
- **The GitHub deploy-trigger branch binds to the service, not the
  environment.** Verify with `railway status --json` per environment.
- **`railway domain` is not read-only.** Run against a service with no domain it
  generates one.
- **Custom-domain certificates are staged.** After publishing the CNAME and the
  `_railway-verify` TXT (via the `cloudflare-dns-ops` skill), check `railway domain
  status <domain> --json` rather than assuming it is live.
- **Rotating `DATABASE_URL` or a key on a live environment** is a real change;
  confirm the specific action first.
- **Destructive or credential-changing commands need explicit confirmation.**

## 8. Cutover from the Cloudflare snapshot

The previous production was a static snapshot on a Cloudflare Worker, published
from a laptop. To move:

1. Complete §3–§5 in a fresh `staging` environment. Trigger the cron once and
   compare `/api/dashboard` against a local `npm run api` on the same data: the
   composite, every pillar and every watchlist verdict must match.
2. Repeat in `production` with its own fresh services.
3. Point the domain at `worldhealth-api` (CNAME + `_railway-verify` TXT).
4. Delete the old Worker (`wrangler delete`) once the domain has moved; nothing
   in the repo deploys it any more.
