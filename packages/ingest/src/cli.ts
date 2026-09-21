#!/usr/bin/env node
import {
  addDays, collectAlerts, describeError, hasRunFailure, log,
  summarizeAlerts, todayIso,
  type Alert, type CompositeScore, type Store, type WatchlistResult,
} from '@wd/core';
import {
  PostgresStore, SqliteStore, copyStore, createCache, describeStoreTarget, openStore, resolveStoreTarget,
} from '@wd/store';
import { CONNECTORS, connectorHealth, getConnector } from '@wd/connectors';
import { loadEnv } from './config.js';
import { runAll, type RunOutcome } from './runner.js';
import { backfillSince, pendingBackfills, recordBackfill, runPendingBackfills } from './backfill.js';
import { deriveAll, type DeriveOutcome } from './derive.js';
import { computeAndStoreScores } from './score.js';
import { runStage, type StageResult } from './stage.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

function parseArgs(argv: string[]): { cmd: string; flags: Map<string, string> } {
  const cmd = argv[0] ?? 'help';
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags.set(a.slice(2), next); i++; }
      else flags.set(a.slice(2), 'true');
    }
  }
  return { cmd, flags };
}

function selectConnectors(flags: Map<string, string>) {
  const only = flags.get('only');
  if (!only) return CONNECTORS;
  const ids = only.split(',').map((s) => s.trim());
  const selected = ids.map((id) => {
    const c = getConnector(id);
    if (!c) throw new Error(`Unknown connector "${id}". Known: ${CONNECTORS.map((x) => x.id).join(', ')}`);
    return c;
  });
  return selected;
}

function printOutcome(o: RunOutcome): void {
  const icon = { ok: `${C.green}ok${C.reset}`, partial: `${C.yellow}partial${C.reset}`,
    error: `${C.red}ERROR${C.reset}`, skipped: `${C.dim}skipped${C.reset}` }[o.status];
  const detail = o.status === 'error' || o.status === 'skipped'
    ? ` ${C.dim}${o.error ?? ''}${C.reset}`
    : ` ${o.rows} rows${o.events ? `, ${o.events} events` : ''}`;
  console.log(`  ${icon.padEnd(20)} ${o.sourceId.padEnd(24)}${detail} ${C.dim}(${o.durationMs}ms)${C.reset}`);
  if (o.status === 'partial' && o.warnings?.length) {
    for (const w of o.warnings.slice(0, 3)) console.log(`      ${C.dim}! ${w}${C.reset}`);
  }
}

function summarise(results: RunOutcome[], dryRun = false): number {
  const by = (s: string) => results.filter((r) => r.status === s).length;
  const rows = results.reduce((a, r) => a + r.rows, 0);
  // `doctor` fetches without writing, so calling these "written" contradicts its
  // own "(no writes)" header.
  const verb = dryRun ? 'fetched, none written' : 'written';
  console.log(`\n${C.bold}${by('ok')} ok, ${by('partial')} partial, ${by('error')} error, ${by('skipped')} skipped${C.reset} — ${rows} observations ${verb}`);
  const failed = results.filter((r) => r.status === 'error');
  if (failed.length) {
    console.log(`\n${C.red}Failures:${C.reset}`);
    for (const f of failed) console.log(`  ${f.sourceId}: ${f.error}`);
  }
  // Non-zero only on hard failure, so a cron wrapper can distinguish "a feed
  // broke" from "the whole run broke".
  return failed.length > 0 ? 1 : 0;
}

/** Connector outcomes in the shape `pipeline_runs` stores. */
function ingestStageResult(results: RunOutcome[]): StageResult {
  const failed = results.filter((r) => r.status === 'error');
  return {
    okCount: results.filter((r) => r.status === 'ok' || r.status === 'partial').length,
    failCount: failed.length,
    rowsWritten: results.reduce((a, r) => a + r.rows, 0),
    failed: failed.map((f) => ({ id: f.sourceId, error: f.error ?? null })),
    detail: {
      skipped: results.filter((r) => r.status === 'skipped').map((r) => r.sourceId),
      partial: results.filter((r) => r.status === 'partial').map((r) => r.sourceId),
    },
  };
}

function deriveStageResult(outcomes: DeriveOutcome[]): StageResult {
  const failed = outcomes.filter((o) => o.status === 'error');
  return {
    okCount: outcomes.filter((o) => o.status === 'ok').length,
    failCount: failed.length,
    rowsWritten: outcomes.reduce((a, o) => a + o.rows, 0),
    failed: failed.map((f) => ({ id: f.id, error: f.detail ?? null })),
    detail: { skipped: outcomes.filter((o) => o.status === 'skipped').map((o) => o.id) },
  };
}

const ALERT_MARK: Record<Alert['severity'], string> = {
  critical: `${C.red}■${C.reset}`,
  warning: `${C.yellow}▲${C.reset}`,
  info: `${C.dim}·${C.reset}`,
};

/**
 * The same alerts the dashboard renders, in the terminal.
 *
 * Deliberately the same `collectAlerts` call the API makes rather than a
 * parallel set of CLI checks — a cron job that reports "all clear" while the
 * page shows three failures is how an operator learns to ignore both.
 */
function printAlerts(alerts: Alert[]): void {
  const sum = summarizeAlerts(alerts);
  if (sum.total === 0) {
    console.log(`\n  ${C.green}No open alerts${C.reset} ${C.dim}— pipeline current, no failed source, nothing past its refresh budget${C.reset}`);
    return;
  }
  console.log(`\n${C.bold}Alerts${C.reset} ${C.dim}(${sum.critical} critical, ${sum.warning} warning, ${sum.info} info)${C.reset}\n`);
  for (const a of alerts) {
    console.log(`  ${ALERT_MARK[a.severity]} ${C.bold}${a.title}${C.reset}`);
    console.log(`    ${C.dim}${a.detail}${C.reset}`);
    if (a.action) console.log(`    ${C.cyan}→ ${a.action}${C.reset}`);
  }
}

function bar(score: number, width = 24): string {
  if (!Number.isFinite(score)) return C.dim + '─'.repeat(width) + C.reset;
  const filled = Math.round((score / 100) * width);
  const colour = score >= 70 ? C.red : score >= 45 ? C.yellow : C.green;
  return `${colour}${'█'.repeat(filled)}${C.dim}${'░'.repeat(width - filled)}${C.reset}`;
}

function printScores(composite: CompositeScore, watchlist: WatchlistResult[], asOf: string): void {
  const s = composite.score;
  const colour = !Number.isFinite(s) ? C.dim : s >= 70 ? C.red : s >= 45 ? C.yellow : C.green;
  console.log(`\n  ${C.bold}Composite${C.reset}  ${colour}${C.bold}${Number.isFinite(s) ? s.toFixed(1) : 'n/a'}${C.reset}  ${bar(s)}  ${colour}${composite.regime}${C.reset}`);
  console.log(`  ${C.dim}as of ${asOf} · ${composite.pillarsElevated} pillar(s) elevated · ${(composite.coverage * 100).toFixed(0)}% pillar coverage${C.reset}\n`);

  for (const p of composite.pillars) {
    const cov = `${(p.coverage * 100).toFixed(0)}%`;
    const val = Number.isFinite(p.score) ? p.score.toFixed(1).padStart(5) : '  n/a';
    const lowCov = p.coverage < 0.34 ? ` ${C.yellow}(excluded: low coverage)${C.reset}` : '';
    console.log(`  ${p.pillar.padEnd(11)} ${val}  ${bar(p.score, 18)}  ${C.dim}${p.indicators.length} ind, ${cov} cov${C.reset}${lowCov}`);
  }

  const lit = watchlist.filter((w) => w.available && w.triggered);
  const unknown = watchlist.filter((w) => !w.available);
  console.log(`\n  ${C.bold}Depression precursors${C.reset} ${C.dim}(${lit.length} triggered, ${unknown.length} unavailable)${C.reset}`);
  for (const w of watchlist) {
    const mark = !w.available ? `${C.dim}? ${C.reset}` : w.triggered ? `${C.red}▲ ${C.reset}` : `${C.green}· ${C.reset}`;
    const name = w.triggered ? `${C.bold}${w.name}${C.reset}` : w.available ? w.name : `${C.dim}${w.name}${C.reset}`;
    console.log(`  ${mark}${name}`);
    console.log(`      ${C.dim}${w.detail}${C.reset}`);
  }
}

/**
 * Keep this many days of raw responses. Long enough to replay last week's
 * bytes after a parser fix; short enough that the bucket does not grow
 * forever, since nothing else removes an entry whose URL changed.
 */
function cacheRetentionDays(): number {
  const n = Number(process.env.WD_CACHE_RETENTION_DAYS ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = openStore(resolveStoreTarget());
  try {
    await store.migrate();
    return await fn(store);
  } finally {
    await store.close();
  }
}

async function main(): Promise<void> {
  loadEnv();
  const { cmd, flags } = parseArgs(process.argv.slice(2));

  switch (cmd) {
    case 'migrate': {
      // The deploy step: Railway runs this before a new release takes traffic.
      const target = resolveStoreTarget();
      const store = openStore(target);
      try {
        const ran = await store.migrateReport();
        console.log(ran.length
          ? `${C.green}Applied migration(s) ${ran.join(', ')}${C.reset} to ${describeStoreTarget(target)}`
          : `${C.green}Schema current${C.reset} at ${describeStoreTarget(target)}`);
        log.info('migrate', { applied: ran, store: describeStoreTarget(target) });
      } finally {
        await store.close();
      }
      break;
    }

    case 'copy-store': {
      // One-off initial load of a local SQLite history into the production
      // Postgres. Safe to re-run: rows already in the target are kept.
      const from = flags.get('from');
      const to = resolveStoreTarget(flags.has('to') ? { DATABASE_URL: flags.get('to') } : process.env);
      if (!from || from === 'true') throw new Error('copy-store needs --from <path to world.db>');
      if (to.kind !== 'postgres') throw new Error('copy-store target must be Postgres: set DATABASE_URL or pass --to');
      const source = new SqliteStore(from);
      const target = new PostgresStore({ connectionString: to.connectionString });
      try {
        await source.migrate();
        await target.migrate();
        console.log(`${C.bold}Copying${C.reset} ${from} → ${describeStoreTarget(to)} ${C.dim}(raw_cache skipped)${C.reset}\n`);
        const copied = await copyStore(source, target, (p) => {
          if (process.stdout.isTTY) process.stdout.write(`\r  ${p.table.padEnd(16)} ${p.copied}/${p.total}`);
        });
        if (process.stdout.isTTY) process.stdout.write('\n');
        for (const c of copied) console.log(`  ${C.green}ok${C.reset} ${c.table.padEnd(16)} ${c.rows} rows`);
      } finally {
        await source.close();
        await target.close();
      }
      break;
    }

    case 'sources': {
      console.log(`${C.bold}Registered connectors${C.reset}\n`);
      for (const c of CONNECTORS) {
        const key = c.requiresKey
          ? (process.env[c.requiresKey] ? `${C.green}${c.requiresKey} set${C.reset}` : `${C.yellow}needs ${c.requiresKey}${C.reset}`)
          : `${C.dim}no key${C.reset}`;
        const tags = [c.cadence, c.optional ? 'optional' : null].filter(Boolean).join(', ');
        console.log(`  ${C.cyan}${c.id.padEnd(24)}${C.reset} ${key}`);
        console.log(`    ${c.name} ${C.dim}(${tags})${C.reset}`);
        if (c.caveat) console.log(`    ${C.yellow}caveat:${C.reset} ${C.dim}${c.caveat}${C.reset}`);
      }
      break;
    }

    case 'doctor': {
      // Fetch with cache disabled but write nothing: the fastest way to tell a
      // missing key from a changed upstream schema.
      const connectors = selectConnectors(flags);
      console.log(`${C.bold}Probing ${connectors.length} sources${C.reset} ${C.dim}(no writes)${C.reset}\n`);
      const results = await withStore((store) => runAll(
        connectors, store,
        { since: addDays(todayIso(), -10), dryRun: true, noCache: true },
        4, printOutcome,
      ));
      process.exitCode = summarise(results, true);
      break;
    }

    case 'ingest': {
      const connectors = selectConnectors(flags);
      // A 120-day lookback absorbs upstream revisions without refetching history.
      const since = flags.get('since') ?? addDays(todayIso(), -120);
      const dryRun = flags.get('dry-run') === 'true';
      console.log(`${C.bold}Ingesting ${connectors.length} sources${C.reset} since ${since}\n`);
      const results = await withStore((store) => runStage(store, 'ingest', async () => {
        const out = await runAll(
          connectors, store,
          { since, dryRun, noCache: flags.get('no-cache') === 'true', cache: createCache() },
          4, printOutcome,
        );
        // A dry run must not leave a row claiming the data was updated.
        return { result: out, ...(dryRun ? { status: 'skipped' as const } : ingestStageResult(out)) };
      }));
      process.exitCode = summarise(results, dryRun);
      break;
    }

    case 'backfill': {
      const connectors = selectConnectors(flags);
      // Percentile transforms need decades to be meaningful; default to 25 years.
      const since = flags.get('since') ?? backfillSince();
      const dryRun = flags.get('dry-run') === 'true';
      console.log(`${C.bold}Backfilling ${connectors.length} sources${C.reset} since ${since}`);
      console.log(`${C.dim}This can take a few minutes and will hit upstream rate limits if repeated.${C.reset}\n`);
      const results = await withStore((store) => runStage(store, 'backfill', async () => {
        const out = await runAll(
          connectors, store,
          { since, dryRun, noCache: flags.get('no-cache') === 'true', cache: createCache() },
          2, printOutcome,
        );
        // Recorded so `daily` does not backfill the same series again. A
        // short `--since` is recorded too: it was asked for explicitly.
        if (!dryRun) for (const o of out) await recordBackfill(store, o, since);
        // A dry run must not leave a row claiming the data was updated.
        return { result: out, ...(dryRun ? { status: 'skipped' as const } : ingestStageResult(out)) };
      }));
      process.exitCode = summarise(results, dryRun);
      break;
    }

    case 'derive': {
      const since = flags.get('since') ?? '1900-01-01';
      await withStore(async (store) => {
        const outcomes = await runStage(store, 'derive', async () => {
          const out = await deriveAll(store, since);
          return { result: out, ...deriveStageResult(out) };
        });
        for (const o of outcomes) {
          const icon = o.status === 'ok' ? `${C.green}ok${C.reset}`
            : o.status === 'skipped' ? `${C.dim}skipped${C.reset}` : `${C.red}ERROR${C.reset}`;
          console.log(`  ${icon.padEnd(20)} ${o.id.padEnd(28)} ${o.rows ? `${o.rows} rows` : ''} ${C.dim}${o.detail ?? ''}${C.reset}`);
        }
        const ok = outcomes.filter((o) => o.status === 'ok').length;
        const failed = outcomes.filter((o) => o.status === 'error');
        console.log(`\n${C.bold}${ok}/${outcomes.length} derivations computed${C.reset}`);
        if (failed.length) console.log(`${C.red}${failed.length} failed${C.reset} — see the Sources tab or run with --no-cache`);
        process.exitCode = failed.length > 0 ? 1 : 0;
      });
      break;
    }

    case 'score': {
      const asOf = flags.get('as-of') ?? todayIso();
      const persist = flags.get('dry-run') !== 'true';
      await withStore(async (store) => {
        const { composite, watchlist } = await runStage(store, 'score', async () => {
          const out = await computeAndStoreScores(store, asOf, persist);
          return {
            result: out,
            okCount: out.composite.pillars.filter((p) => Number.isFinite(p.score)).length,
            status: persist ? undefined : ('skipped' as const),
            detail: {
              asOf,
              composite: Number.isFinite(out.composite.score) ? out.composite.score : null,
              regime: out.composite.regime,
              coverage: out.composite.coverage,
              triggered: out.watchlist.filter((w) => w.available && w.triggered).map((w) => w.id),
            },
          };
        });
        printScores(composite, watchlist, asOf);
      });
      break;
    }

    case 'daily': {
      // The single command a scheduler runs: fetch, derive, then score.
      const since = flags.get('since') ?? addDays(todayIso(), -120);
      console.log(`${C.bold}Daily update${C.reset} ${C.dim}(ingest → derive → score)${C.reset}\n`);
      const cache = createCache();
      await withStore(async (store) => {
        // The outer stage is the proof the scheduler fired at all. Each inner
        // stage records its own row, so a failure is attributable to the step
        // that failed rather than to "the daily job".
        await runStage(store, 'daily', async () => {
          const results = await runStage(store, 'ingest', async () => {
            const out = await runAll(CONNECTORS, store, { since, cache }, 4, printOutcome);
            return { result: out, ...ingestStageResult(out) };
          });
          summarise(results);

          // A source or catalogue entry added in code arrives here: ingest has
          // just declared its series with 120 days of data, and nothing has
          // recorded a backfill for them yet. Only recorded as a stage when
          // there was something to do, so a quiet day adds no noise.
          const { outcomes: backfilled, pendingSeries } = await (async () => {
            const pending = await pendingBackfills(store, CONNECTORS);
            if (pending.size === 0) return { outcomes: [] as RunOutcome[], pendingSeries: 0 };
            console.log(`\n${C.bold}Backfilling new series${C.reset} ${C.dim}(${[...pending.values()].flat().length} series from ${[...pending.keys()].join(', ')})${C.reset}`);
            return runStage(store, 'backfill', async () => {
              const out = await runPendingBackfills(store, CONNECTORS, { cache, onResult: printOutcome });
              return { result: out, ...ingestStageResult(out.outcomes) };
            });
          })();
          if (pendingSeries === 0) console.log(`\n${C.dim}No new series to backfill${C.reset}`);
          const backfillFailed = backfilled.filter((r) => r.status === 'error');

          console.log(`\n${C.bold}Derived series${C.reset}`);
          const derived = await runStage(store, 'derive', async () => {
            const out = await deriveAll(store, '1900-01-01');
            return { result: out, ...deriveStageResult(out) };
          });
          const okd = derived.filter((o) => o.status === 'ok').length;
          const errd = derived.filter((o) => o.status === 'error');
          console.log(`  ${okd}/${derived.length} computed`);
          for (const e of errd) console.log(`  ${C.red}${e.id}: ${e.detail}${C.reset}`);

          console.log(`\n${C.bold}Scoring${C.reset}`);
          const { composite, watchlist } = await runStage(store, 'score', async () => {
            const out = await computeAndStoreScores(store, todayIso());
            return {
              result: out,
              okCount: out.composite.pillars.filter((p) => Number.isFinite(p.score)).length,
              detail: {
                asOf: todayIso(),
                composite: Number.isFinite(out.composite.score) ? out.composite.score : null,
                regime: out.composite.regime,
                coverage: out.composite.coverage,
              },
            };
          });
          printScores(composite, watchlist, todayIso());

          const ingestFailed = [...results, ...backfillFailed].filter((r) => r.status === 'error');
          const deriveFailed = errd;
          return {
            result: undefined,
            okCount: results.filter((r) => r.status === 'ok').length + okd,
            failCount: ingestFailed.length + deriveFailed.length,
            rowsWritten: [...results, ...backfilled].reduce((a, r) => a + r.rows, 0) + derived.reduce((a, d) => a + d.rows, 0),
            failed: [
              ...ingestFailed.map((r) => ({ id: r.sourceId, error: r.error ?? null })),
              ...deriveFailed.map((d) => ({ id: d.id, error: d.detail ?? null })),
            ],
            detail: { composite: Number.isFinite(composite.score) ? composite.score : null, regime: composite.regime },
          };
        });

        // Outside the stages on purpose: a cache that cannot be pruned is a
        // storage bill, not a failed update, and must not turn the run red.
        try {
          const cutoff = new Date(Date.now() - cacheRetentionDays() * 86_400_000);
          const pruned = await cache.prune(cutoff);
          log.info('cache pruned', { cache: cache.describe(), removed: pruned, retentionDays: cacheRetentionDays() });
        } catch (err) {
          log.warn('cache prune failed', { err, cache: cache.describe() });
        }

        // The run ends with the same list the dashboard shows, so whoever reads
        // the cron output and whoever opens the page see one story.
        const alerts = await collectAlerts(store, { connectors: connectorHealth() });
        printAlerts(alerts);

        // Only a failure of *this run* is worth a non-zero exit. Long-standing
        // staleness is critical on the page but would otherwise leave the
        // systemd unit red every night until somebody fixed an upstream they
        // do not control.
        process.exitCode = hasRunFailure(alerts) ? 1 : 0;
      });
      break;
    }

    case 'alerts': {
      // Read-only: the operational view of the same state the dashboard renders.
      await withStore(async (store) => {
        const alerts = await collectAlerts(store, { connectors: connectorHealth() });
        printAlerts(alerts);
        const runs = await store.getLatestPipelineRuns();
        if (runs.length > 0) {
          console.log(`\n${C.bold}Last run of each stage${C.reset}`);
          for (const r of runs) {
            const tone = r.status === 'ok' ? C.green : r.status === 'error' ? C.red : C.yellow;
            console.log(`  ${tone}${r.status.padEnd(8)}${C.reset} ${r.stage.padEnd(10)} ${C.dim}${r.startedAt} · ${r.okCount} ok, ${r.failCount} failed, ${r.rowsWritten} rows${C.reset}`);
          }
        }
        process.exitCode = summarizeAlerts(alerts).critical > 0 ? 1 : 0;
      });
      break;
    }

    case 'health': {
      await withStore(async (store) => {
        const health = await store.getSeriesHealth();
        const stale = health.filter((h) => h.stale);
        console.log(`${C.bold}${health.length} series${C.reset}, ${stale.length ? C.yellow : C.green}${stale.length} stale${C.reset}\n`);
        for (const h of stale) {
          const age = h.ageDays === null ? 'never loaded' : `${h.ageDays}d old (budget ${h.stalenessBudgetDays}d)`;
          console.log(`  ${C.yellow}${h.seriesId.padEnd(32)}${C.reset} ${age}`);
        }
      });
      break;
    }

    default:
      console.log(`
${C.bold}world-dashboard ingest CLI${C.reset}

  ${C.cyan}migrate${C.reset}                 Apply pending schema migrations (the deploy step)
  ${C.cyan}copy-store${C.reset} --from <db>     One-off: copy a local SQLite DB into DATABASE_URL (Postgres)
  ${C.cyan}sources${C.reset}                 List connectors and their key status
  ${C.cyan}doctor${C.reset}                  Probe every source, write nothing
  ${C.cyan}ingest${C.reset}                  Daily incremental fetch (last 120 days)
  ${C.cyan}backfill${C.reset}                Load deep history (default 25 years)
  ${C.cyan}derive${C.reset}                  Recompute derived series from stored data
  ${C.cyan}score${C.reset}                   Compute composite, pillar and watchlist scores
  ${C.cyan}daily${C.reset}                   ingest → backfill new series → derive → score (the scheduler entrypoint)
  ${C.cyan}health${C.reset}                  Report stale series
  ${C.cyan}alerts${C.reset}                  What is broken and what to run (exit 1 on anything critical)

${C.bold}Flags${C.reset}
  --only <id,id>          Restrict to named connectors
  --since <YYYY-MM-DD>    Override the start date
  --dry-run               Fetch and parse without writing
  --no-cache              Refetch rather than read the raw response cache
  --as-of <YYYY-MM-DD>    Score as of a past date (point-in-time, for backtests)

${C.bold}Database${C.reset}
  DATABASE_URL=postgres://…        Production store; unset means local SQLite
  WD_DB_PATH=/path/world.db        SQLite file (default data/world.db)

${C.bold}Raw response cache${C.reset}
  WD_CACHE_URL=s3://bucket/prefix  S3-compatible store (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)
  WD_CACHE_URL=file:/dir | none    Directory (default data/cache) or nothing
  WD_CACHE_RETENTION_DAYS=30       daily prunes entries older than this

${C.bold}Logging${C.reset} ${C.dim}(structured, on stderr — stdout stays the report above)${C.reset}
  WD_LOG_LEVEL=debug|info|warn|error|silent
  WD_LOG_FORMAT=text|json          Defaults to text on a terminal, json otherwise
  WD_LOG_FILE=/path/to/run.log     Append every line here as well
`);
  }
}

main().catch((err) => {
  // A crash here is a crash of the CLI itself — a stage that threw has already
  // recorded its own `pipeline_runs` row on the way past, so the dashboard
  // knows about it even though this process is about to stop existing.
  log.error('fatal', { err });
  console.error(`${C.red}Fatal:${C.reset}`, describeError(err).message);
  process.exit(1);
});
