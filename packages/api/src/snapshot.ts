#!/usr/bin/env node
/**
 * Build a static snapshot of every API response, for hosts that serve the read
 * path only (see `docs/deploy-cloudflare.md`).
 *
 * The snapshot is produced by calling the real routes rather than by
 * reassembling their payloads here. `createRoutes` is mounted into a Hono app
 * and driven through `app.request()`, which needs no listening socket — so the
 * bytes written are the bytes `npm run api` would serve, by construction. A
 * second implementation of the dashboard payload would be a second thing to
 * keep correct, and the first one to drift.
 *
 * Output is a single directory that is both the web bundle and the API:
 *
 *     index.html, assets/…        the Vite build, copied verbatim
 *     api/dashboard.json          one file per route
 *     api/pillar/<pillar>.json
 *     api/series/<id>.json
 *     api/snapshot.json           manifest: build time, route list, sizes
 *
 * `worker.ts` maps a request for `/api/dashboard` onto `api/dashboard.json`.
 * The `.json` suffix is what keeps the two halves from colliding: no snapshot
 * file is reachable at the path the client actually asks for, so the Worker is
 * always the thing that answers an API request and can attach cache headers.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { log, SqliteStore } from '@wd/core';
import { apiErrorHandler, createRoutes } from './routes.js';

const logger = log.child('snapshot');

const ROOT = resolve(import.meta.dirname, '../../..');
const dbPath = process.env.WD_DB_PATH ?? resolve(ROOT, 'data/world.db');
const configPath = process.env.WD_CONFIG_PATH ?? resolve(ROOT, 'config/indicators.yaml');
const outDir = process.env.WD_SNAPSHOT_DIR ?? resolve(ROOT, 'dist-cloudflare');
const webDist = resolve(ROOT, 'packages/web/dist');

/**
 * The limit `api.events()` asks for in `packages/web/src/api.ts`. A snapshot is
 * matched to a path, not to a query string — the Worker serves the same file
 * whatever `?limit=` says — so this has to be the number the client sends.
 */
const EVENTS_LIMIT = 120;

/** Workers Static Assets caps, from `docs/deploy-cloudflare.md` §1. */
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
};

interface Written { file: string; bytes: number }

const written: Written[] = [];
const warnings: string[] = [];

/** Assigned by `build()` before any `capture()` call. */
let app: Hono | undefined;

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * Every file that will actually be uploaded, not just the ones written here.
 *
 * The asset caps apply to the published directory as a whole, so counting only
 * the API payloads would measure the wrong thing — the copied web bundle
 * occupies the same budget.
 */
async function walk(dir: string): Promise<Written[]> {
  const out: Written[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out.push({ file: full.slice(outDir.length + 1), bytes: (await stat(full)).size });
  }
  return out;
}

function fail(path: string, file: string, why: string, fatal: boolean): null {
  const line = `${path} → ${why}`;
  if (fatal) {
    console.error(`  ${C.red}FAIL${C.reset} ${line}`);
    logger.error('route failed', { path, file, why });
  } else {
    warnings.push(line);
    logger.warn('route failed', { path, file, why });
  }
  return null;
}

/**
 * Run one route and write its body.
 *
 * `fatal` separates the routes the page cannot open without from the per-series
 * files, where one failure is a gap in a drill-down rather than a broken
 * dashboard — the same reasoning as the isolated-connector-failure invariant.
 */
async function capture(path: string, file: string, fatal: boolean): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await app!.request(path);
  } catch (err) {
    return fail(path, file, String(err), fatal);
  }
  const body = await res.text();
  if (!res.ok) return fail(path, file, `${res.status} ${body.slice(0, 160)}`, fatal);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // A 200 carrying something the client cannot parse is worse than a failure,
    // because it reaches the browser looking like data.
    return fail(path, file, 'response was not valid JSON', fatal);
  }

  const dest = join(outDir, file);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, body);
  written.push({ file, bytes: Buffer.byteLength(body) });
  logger.debug('captured', { path, file, bytes: Buffer.byteLength(body) });
  return parsed;
}

async function build(): Promise<number> {
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}. Run "npm run migrate && npm run daily" first.`);
    return 1;
  }
  // Without the bundle this would publish an API with no dashboard in front of
  // it — a broken deploy that looks like a successful one until it is opened.
  if (!existsSync(join(webDist, 'index.html'))) {
    console.error(`No web bundle at ${webDist}. Run "npm -w @wd/web run build" first.`);
    return 1;
  }

  const store = new SqliteStore(dbPath);
  await store.migrate();

  app = new Hono();
  app.route('/', createRoutes({ store, configPath }));
  // A mounted sub-app's handler does not cover the parent, exactly as in
  // `server.ts`: without this a thrown route is a bare 500 with no log line.
  app.onError(apiErrorHandler);

  const t0 = Date.now();
  console.log(`${C.bold}Building snapshot${C.reset} ${C.dim}→ ${outDir}${C.reset}`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // The web bundle first, so the API files land in a tree that already has an
  // index.html beside them and a partial run is obvious rather than subtle.
  await cp(webDist, outDir, { recursive: true });
  console.log(`  ${C.green}ok${C.reset}   web bundle`);

  // Fatal group: the dashboard cannot render without these.
  const dashboard = await capture('/api/dashboard', 'api/dashboard.json', true);
  await capture('/api/markets', 'api/markets.json', true);
  await capture(`/api/events?limit=${EVENTS_LIMIT}`, 'api/events.json', true);
  await capture('/api/sources', 'api/sources.json', true);
  await capture('/api/alerts', 'api/alerts.json', true);
  await capture('/api/health', 'api/health.json', true);
  await capture('/api/series', 'api/series.json', true);

  if (dashboard === null) {
    console.error(`${C.red}Aborting: /api/dashboard failed, so the pillar list is unknown.${C.reset}`);
    await store.close();
    return 1;
  }

  const pillars = ((dashboard.pillars ?? []) as Array<{ pillar: string }>).map((p) => p.pillar);
  for (const pillar of pillars) {
    await capture(`/api/pillar/${encodeURIComponent(pillar)}`, `api/pillar/${pillar}.json`, true);
  }
  console.log(`  ${C.green}ok${C.reset}   ${pillars.length} pillars`);

  // One file per series, carrying full history — this is the bulk of the
  // output and the reason the size guard below exists.
  const defs = await store.listSeries();
  let seriesOk = 0;
  for (const def of defs) {
    const got = await capture(`/api/series/${encodeURIComponent(def.id)}`, `api/series/${def.id}.json`, false);
    if (got !== null) seriesOk++;
  }
  console.log(`  ${C.green}ok${C.reset}   ${seriesOk}/${defs.length} series`);

  const totalBytes = written.reduce((a, w) => a + w.bytes, 0);
  await writeFile(
    join(outDir, 'api/snapshot.json'),
    `${JSON.stringify({
      builtAt: new Date().toISOString(),
      asOf: dashboard.asOf ?? null,
      routes: written.length,
      series: seriesOk,
      pillars: pillars.length,
      // The API payloads only — the web bundle beside them is not counted here.
      apiBytes: totalBytes,
      // Named so a stale deploy can be diagnosed from the browser rather than
      // from the build host: fetch /api/snapshot and read the timestamp.
      source: 'npm run snapshot',
    }, null, 2)}\n`,
  );

  await store.close();

  // Static Assets caps are per version, not per account: blowing one turns a
  // deploy into a failure at upload time, long after this process looked fine.
  // Measured over the whole published directory, which is what wrangler uploads.
  const published = await walk(outDir);
  const publishedBytes = published.reduce((a, w) => a + w.bytes, 0);
  const oversize = published.filter((w) => w.bytes > MAX_FILE_BYTES);
  for (const w of oversize) {
    warnings.push(`${w.file} is ${mb(w.bytes)}, over the ${mb(MAX_FILE_BYTES)} per-file asset cap`);
  }
  if (published.length > MAX_FILES) {
    warnings.push(`${published.length} files, over the ${MAX_FILES}-file per-version asset cap`);
  }

  console.log();
  console.log(`${C.bold}${published.length} files${C.reset}, ${mb(publishedBytes)} ${C.dim}in ${((Date.now() - t0) / 1000).toFixed(1)}s${C.reset}`);
  for (const w of warnings) console.log(`  ${C.yellow}warn${C.reset} ${w}`);
  console.log();
  console.log(`Deploy with ${C.bold}npx wrangler deploy${C.reset}`);

  return oversize.length > 0 ? 1 : 0;
}

try {
  process.exitCode = await build();
} catch (err) {
  logger.error('snapshot threw', { err });
  console.error(err);
  process.exitCode = 1;
}
