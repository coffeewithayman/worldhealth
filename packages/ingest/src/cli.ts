#!/usr/bin/env node
import {
  SqliteStore, addDays, addYears, todayIso,
  type CompositeScore, type Store, type WatchlistResult,
} from '@wd/core';
import { CONNECTORS, getConnector } from '@wd/connectors';
import { dbPath, loadEnv } from './config.js';
import { runAll, type RunOutcome } from './runner.js';
import { deriveAll } from './derive.js';
import { computeAndStoreScores } from './score.js';

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

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = new SqliteStore(dbPath());
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
      await withStore(async () => { console.log(`${C.green}Schema applied${C.reset} at ${dbPath()}`); });
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
      console.log(`${C.bold}Ingesting ${connectors.length} sources${C.reset} since ${since}\n`);
      const results = await withStore((store) => runAll(
        connectors, store,
        { since, dryRun: flags.get('dry-run') === 'true', noCache: flags.get('no-cache') === 'true' },
        4, printOutcome,
      ));
      process.exitCode = summarise(results);
      break;
    }

    case 'backfill': {
      const connectors = selectConnectors(flags);
      // Percentile transforms need decades to be meaningful; default to 25 years.
      const since = flags.get('since') ?? addYears(todayIso(), -25);
      console.log(`${C.bold}Backfilling ${connectors.length} sources${C.reset} since ${since}`);
      console.log(`${C.dim}This can take a few minutes and will hit upstream rate limits if repeated.${C.reset}\n`);
      const results = await withStore((store) => runAll(
        connectors, store, { since }, 2, printOutcome,
      ));
      process.exitCode = summarise(results);
      break;
    }

    case 'derive': {
      const since = flags.get('since') ?? '1900-01-01';
      await withStore(async (store) => {
        const outcomes = await deriveAll(store, since);
        for (const o of outcomes) {
          const icon = o.status === 'ok' ? `${C.green}ok${C.reset}`
            : o.status === 'skipped' ? `${C.dim}skipped${C.reset}` : `${C.red}ERROR${C.reset}`;
          console.log(`  ${icon.padEnd(20)} ${o.id.padEnd(28)} ${o.rows ? `${o.rows} rows` : ''} ${C.dim}${o.detail ?? ''}${C.reset}`);
        }
        const ok = outcomes.filter((o) => o.status === 'ok').length;
        console.log(`\n${C.bold}${ok}/${outcomes.length} derivations computed${C.reset}`);
      });
      break;
    }

    case 'score': {
      const asOf = flags.get('as-of') ?? todayIso();
      await withStore(async (store) => {
        const { composite, watchlist } = await computeAndStoreScores(store, asOf, flags.get('dry-run') !== 'true');
        printScores(composite, watchlist, asOf);
      });
      break;
    }

    case 'daily': {
      // The single command a scheduler runs: fetch, derive, then score.
      const since = flags.get('since') ?? addDays(todayIso(), -120);
      console.log(`${C.bold}Daily update${C.reset} ${C.dim}(ingest → derive → score)${C.reset}\n`);
      await withStore(async (store) => {
        const results = await runAll(CONNECTORS, store, { since }, 4, printOutcome);
        summarise(results);

        console.log(`\n${C.bold}Derived series${C.reset}`);
        const derived = await deriveAll(store, '1900-01-01');
        const okd = derived.filter((o) => o.status === 'ok').length;
        const errd = derived.filter((o) => o.status === 'error');
        console.log(`  ${okd}/${derived.length} computed`);
        for (const e of errd) console.log(`  ${C.red}${e.id}: ${e.detail}${C.reset}`);

        console.log(`\n${C.bold}Scoring${C.reset}`);
        const { composite, watchlist } = await computeAndStoreScores(store, todayIso());
        printScores(composite, watchlist, todayIso());

        // Only a hard connector failure is worth a non-zero exit; degraded
        // coverage is normal and already visible in the output.
        process.exitCode = results.some((r) => r.status === 'error' && !getConnector(r.sourceId)?.optional) ? 1 : 0;
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

  ${C.cyan}migrate${C.reset}                 Apply the database schema
  ${C.cyan}sources${C.reset}                 List connectors and their key status
  ${C.cyan}doctor${C.reset}                  Probe every source, write nothing
  ${C.cyan}ingest${C.reset}                  Daily incremental fetch (last 120 days)
  ${C.cyan}backfill${C.reset}                Load deep history (default 25 years)
  ${C.cyan}derive${C.reset}                  Recompute derived series from stored data
  ${C.cyan}score${C.reset}                   Compute composite, pillar and watchlist scores
  ${C.cyan}daily${C.reset}                   ingest → derive → score (the scheduler entrypoint)
  ${C.cyan}health${C.reset}                  Report stale series

${C.bold}Flags${C.reset}
  --only <id,id>          Restrict to named connectors
  --since <YYYY-MM-DD>    Override the start date
  --dry-run               Fetch and parse without writing
  --no-cache              Bypass the raw response cache
  --as-of <YYYY-MM-DD>    Score as of a past date (point-in-time, for backtests)
`);
  }
}

main().catch((err) => {
  console.error(`${C.red}Fatal:${C.reset}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
