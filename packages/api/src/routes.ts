import { Hono, type Context, type ErrorHandler } from 'hono';
import { cors } from 'hono/cors';
import {
  addDays, asOf as valueAsOfDate, BOARD, boardSeriesIds, collectAlerts, computeComposite,
  computeQuoteStats, CURVE_POINTS, describeError, evaluateWatchlist, HEADLINE_ROWS, indexSeries,
  isRateUnit, loadScoringConfig, log, summarizeAlerts, todayIso,
  type BoardRow, type Observation, type PillarCoverage, type QuoteStats, type Store,
} from '@wd/core';
import { CONNECTORS, connectorHealth } from '@wd/connectors';

export interface ApiDeps {
  store: Store;
  configPath: string;
}

const logger = log.child('api');

/**
 * The error handler for every route.
 *
 * Exported because a Hono sub-app's `onError` is not inherited by the app it is
 * mounted into: `server.ts` has to install this one too, or a thrown route
 * lands on Hono's default handler, which logs nothing and returns a bare 500
 * the dashboard cannot explain to the reader.
 */
export const apiErrorHandler: ErrorHandler = (err, c) => {
  const e = describeError(err);
  logger.error('route threw', { err, path: c.req.path, method: c.req.method });
  return c.json({
    error: e.message,
    // Named so the UI can say "the API failed" rather than "no data", which is
    // the distinction that decides whether the reader retries or investigates.
    kind: 'server_error',
    path: c.req.path,
  }, 500);
};

/** Timing and outcome for every API call. Quiet on success, loud otherwise. */
async function requestLog(c: Context, next: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  await next();
  const ms = Date.now() - t0;
  const fields = { method: c.req.method, path: c.req.path, status: c.res.status, ms };
  if (c.res.status >= 500) logger.error('request failed', fields);
  else if (c.res.status >= 400) logger.warn('request rejected', fields);
  // A dashboard request that takes seconds is the early sign of a series that
  // has grown past what loading whole history per request can carry.
  else if (ms > 2000) logger.warn('slow request', fields);
  else logger.debug('request', fields);
}

/**
 * API routes.
 *
 * Built on Hono specifically so this file runs unmodified on Node today and on
 * Cloudflare Workers later — the only thing that changes on migration is the
 * Store implementation injected here.
 *
 * Scores are computed live from stored observations rather than read from the
 * `scores` table, so the dashboard reflects the current config even if you edit
 * weights without re-running the scorer. The stored table is what powers score
 * *history*.
 */
export function createRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  app.use('/api/*', cors());
  app.use('/api/*', requestLog);
  app.onError(apiErrorHandler);

  const seriesCache = new Map<string, Observation[]>();
  const loadSeries = async (ids: string[]): Promise<Map<string, Observation[]>> => {
    const out = new Map<string, Observation[]>();
    for (const id of new Set(ids)) {
      let obs = seriesCache.get(id);
      if (!obs) {
        obs = await deps.store.getObservations(id);
        seriesCache.set(id, obs);
      }
      if (obs.length > 0) out.set(id, obs);
    }
    return out;
  };

  /**
   * Operational alerts, from the same `collectAlerts` the CLI calls.
   *
   * `pillars` is passed only where a composite has just been computed — an
   * excluded pillar is a scoring consequence, and recomputing the whole model
   * to mention it on an endpoint that is not about scoring would be backwards.
   */
  const alertsFor = (pillars?: PillarCoverage[]) =>
    collectAlerts(deps.store, { connectors: connectorHealth(), pillars });

  const WATCHLIST_SERIES = [
    'ust.spread.10y2y', 'd.curve_steepening_90d', 'us.hy_oas', 'd.m2_yoy',
    'd.bank_credit_yoy', 'us.sahm_rule', 'us.cb_liquidity_swaps',
    'd.auction_dealer_avg', 'em.sovereign_oas', 'd.sofr_iorb', 'd.gold_breadth',
  ];

  /** Full dashboard payload in one request — the UI's primary call. */
  app.get('/api/dashboard', async (c) => {
    const asOf = c.req.query('as_of') ?? todayIso();
    const config = loadScoringConfig(deps.configPath);
    const data = await loadSeries([...config.indicators.map((i) => i.seriesId), ...WATCHLIST_SERIES]);

    const composite = computeComposite(config.indicators, data, asOf, { pillarWeights: config.pillarWeights });
    const watchlist = evaluateWatchlist(data, asOf);
    const history = await deps.store.getScoreHistory('composite');
    const health = await deps.store.getSeriesHealth();
    const runs = await deps.store.getLatestRuns();
    const pipeline = await deps.store.getLatestPipelineRuns();
    const alerts = await alertsFor(composite.pillars.map((p) => ({
      pillar: p.pillar, coverage: p.coverage, missing: p.missing,
    })));

    const staleSeries = health.filter((h) => h.stale);
    return c.json({
      asOf,
      composite: {
        score: Number.isFinite(composite.score) ? composite.score : null,
        regime: composite.regime,
        pillarsElevated: composite.pillarsElevated,
        coverage: composite.coverage,
      },
      pillars: composite.pillars.map((p) => ({
        pillar: p.pillar,
        score: Number.isFinite(p.score) ? p.score : null,
        coverage: p.coverage,
        indicatorCount: p.indicators.length,
        missingCount: p.missing.length,
      })),
      watchlist,
      compositeHistory: history,
      // Everything the reader needs to know about whether to believe the
      // numbers above. Shipped with the primary payload rather than behind a
      // second request, so there is no window where the page shows a score
      // without showing that the pipeline feeding it is broken.
      alerts,
      alertSummary: summarizeAlerts(alerts),
      health: {
        totalSeries: health.length,
        staleSeries: staleSeries.length,
        // Surfaced in the UI because the user opted out of notifications:
        // a broken feed has to be visible on the page itself.
        stale: staleSeries.slice(0, 40),
        runs,
        pipeline,
        lastUpdate: pipeline
          .filter((r) => r.stage === 'daily' || r.stage === 'ingest' || r.stage === 'backfill')
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null,
      },
    });
  });

  /** One pillar with every indicator and the arithmetic behind each score. */
  app.get('/api/pillar/:pillar', async (c) => {
    const pillar = c.req.param('pillar');
    const asOf = c.req.query('as_of') ?? todayIso();
    const config = loadScoringConfig(deps.configPath);
    const data = await loadSeries(config.indicators.map((i) => i.seriesId));
    const composite = computeComposite(config.indicators, data, asOf, { pillarWeights: config.pillarWeights });
    const found = composite.pillars.find((p) => p.pillar === pillar);
    if (!found) return c.json({ error: `Unknown pillar "${pillar}"` }, 404);

    const defs = await deps.store.listSeries({ pillar });
    const byId = new Map(defs.map((d) => [d.id, d]));

    // Contribution share: what fraction of the pillar's score each indicator is
    // responsible for. Weight alone does not answer this — a heavily weighted
    // indicator scoring zero contributes nothing, and the drill-down's whole
    // job is to show which readings are actually driving the number.
    const totalContribution = found.indicators.reduce((a, i) => a + i.weight * i.score, 0);

    return c.json({
      pillar: found.pillar,
      score: Number.isFinite(found.score) ? found.score : null,
      coverage: found.coverage,
      missing: found.missing,
      indicators: found.indicators.map((i) => {
        const obs = data.get(i.seriesId) ?? [];
        const stats = computeQuoteStats(obs, { asOf, sparkDays: 730, sparkPoints: 64 });
        return {
          ...i,
          meta: byId.get(i.seriesId) ?? null,
          contribution: totalContribution > 0 ? (i.weight * i.score) / totalContribution : 0,
          spark: stats.spark,
          changes: stats.changes,
          pctMeaningful: stats.pctMeaningful && !isRateUnit(byId.get(i.seriesId)?.unit),
          range52w: stats.range52w,
          percentile5y: stats.percentile5y,
        };
      }),
    });
  });

  /** Raw observations for charting, plus the series metadata and provenance. */
  app.get('/api/series/:id', async (c) => {
    const id = c.req.param('id');
    const from = c.req.query('from');
    const def = await deps.store.getSeries(id);
    if (!def) return c.json({ error: `Unknown series "${id}"` }, 404);
    const obs = await deps.store.getObservations(id, from);
    const health = (await deps.store.getSeriesHealth()).find((h) => h.seriesId === id) ?? null;
    // As-of today, not as-of the last observation: the reader needs to know the
    // number is three days old, and dating it from itself always says "today".
    const stats = computeQuoteStats(obs, { asOf: todayIso(), sparkDays: 365, sparkPoints: 96 });
    return c.json({
      series: def,
      health,
      stats: { ...stats, spark: [], pctMeaningful: stats.pctMeaningful && !isRateUnit(def.unit) },
      // Full history is sent once; the client slices it for every range button
      // rather than making a round trip per range.
      observations: obs,
    });
  });

  app.get('/api/series', async (c) => {
    const pillar = c.req.query('pillar') ?? undefined;
    const sourceId = c.req.query('source') ?? undefined;
    return c.json({ series: await deps.store.listSeries({ pillar, sourceId }) });
  });

  /**
   * The markets board: every curated price panel in one payload.
   *
   * All the arithmetic — changes over seven windows, the 52-week range, the
   * five-year percentile, the sparkline — happens here. The alternative is
   * shipping decades of observations for a hundred rows and recomputing it in
   * the browser on every render, which is both slower and impossible to test.
   */
  app.get('/api/markets', async (c) => {
    const asOf = c.req.query('as_of') ?? todayIso();
    const data = await loadSeries(boardSeriesIds());
    const defs = await deps.store.listSeries();
    const metaById = new Map(defs.map((d) => [d.id, d]));
    const health = await deps.store.getSeriesHealth();
    const healthById = new Map(health.map((h) => [h.seriesId, h]));

    const statsCache = new Map<string, QuoteStats>();
    const statsFor = (id: string): QuoteStats => {
      let hit = statsCache.get(id);
      if (!hit) {
        hit = computeQuoteStats(data.get(id) ?? [], { asOf, sparkDays: 365, sparkPoints: 72 });
        statsCache.set(id, hit);
      }
      return hit;
    };

    const quote = (row: BoardRow) => {
      const meta = metaById.get(row.seriesId) ?? null;
      const stats = statsFor(row.seriesId);
      const h = healthById.get(row.seriesId);
      const gold = row.goldSeriesId ? statsFor(row.goldSeriesId) : null;
      return {
        seriesId: row.seriesId,
        label: row.label,
        hint: row.hint ?? meta?.notes ?? null,
        rising: row.rising ?? 'neutral',
        decimals: row.decimals ?? null,
        bp: row.bp ?? false,
        unit: meta?.unit ?? '',
        cadence: meta?.cadence ?? 'irregular',
        sourceId: meta?.sourceId ?? '',
        sourceUrl: meta?.sourceUrl ?? null,
        stale: h?.stale ?? false,
        ...stats,
        // A rate is quoted in basis points, never in percent-of-a-percent.
        pctMeaningful: stats.pctMeaningful && !isRateUnit(meta?.unit),
        // The currency board's last column, and the point of the whole panel:
        // what a year has done to this currency measured in gold. Inverted from
        // the gold price deliberately — a 25% rise in the gold price is a 20%
        // fall in the currency, and the second sentence is the one that means
        // something to somebody holding the currency.
        vsGold: gold?.changes.y1
          ? { pct: (gold.changes.y1.fromValue / (gold.last?.value ?? NaN) - 1) * 100, date: gold.last?.date ?? null }
          : null,
      };
    };

    // Treasury curve: today against a month and a year ago, so the shape change
    // is visible rather than inferred from two separate line charts. Compared on
    // calendar dates rather than array offsets, because the maturities have
    // different histories and an index offset would silently misalign them.
    const anyCurve = data.get('ust.yield.10y') ?? [];
    const curveDate = anyCurve.at(-1)?.obsDate ?? asOf;
    const curveAt = (backDays: number) => {
      const on = addDays(curveDate, -backDays);
      return CURVE_POINTS.map((pt) => {
        const obs = data.get(pt.seriesId) ?? [];
        const value = obs.length === 0 ? null : valueAsOfDate(indexSeries(obs), on);
        return { ...pt, value };
      });
    };

    return c.json({
      asOf,
      groups: BOARD.map((g) => ({
        id: g.id,
        label: g.label,
        blurb: g.blurb,
        lead: g.lead,
        rows: g.rows.map(quote),
      })),
      headline: HEADLINE_ROWS
        .map((id) => {
          for (const g of BOARD) {
            const row = g.rows.find((r) => r.seriesId === id);
            if (row) return quote(row);
          }
          return null;
        })
        .filter((x) => x !== null),
      curve: {
        asOf: curveDate,
        today: curveAt(0),
        monthAgo: curveAt(30),
        yearAgo: curveAt(365),
      },
    });
  });

  app.get('/api/events', async (c) => {
    const limit = Number(c.req.query('limit') ?? 100);
    const category = c.req.query('category') ?? undefined;
    return c.json({ events: await deps.store.listEvents({ limit, category }) });
  });

  /** Source health: last run, staleness, and the caveats attached to each connector. */
  app.get('/api/sources', async (c) => {
    const runs = await deps.store.getLatestRuns();
    const runById = new Map(runs.map((r) => [r.sourceId, r]));
    const health = await deps.store.getSeriesHealth();
    const allSeries = await deps.store.listSeries();
    const seriesBySource = new Map<string, string[]>();
    for (const s of allSeries) {
      const list = seriesBySource.get(s.sourceId) ?? [];
      list.push(s.id);
      seriesBySource.set(s.sourceId, list);
    }
    const healthById = new Map(health.map((h) => [h.seriesId, h]));

    const sources = CONNECTORS.map((conn) => {
      const ids = seriesBySource.get(conn.id) ?? [];
      const stale = ids.filter((id) => healthById.get(id)?.stale).length;
      return {
        id: conn.id,
        name: conn.name,
        homepage: conn.homepage,
        cadence: conn.cadence,
        requiresKey: conn.requiresKey ?? null,
        optional: conn.optional ?? false,
        caveat: conn.caveat ?? null,
        seriesCount: ids.length,
        staleCount: stale,
        lastRun: runById.get(conn.id) ?? null,
      };
    });

    // Derived series have no connector but still need health reporting.
    const derivedIds = seriesBySource.get('derived') ?? [];
    if (derivedIds.length > 0) {
      sources.push({
        id: 'derived',
        name: 'Derived series (computed locally)',
        homepage: '',
        cadence: 'daily',
        requiresKey: null,
        optional: false,
        caveat: null,
        seriesCount: derivedIds.length,
        staleCount: derivedIds.filter((id) => healthById.get(id)?.stale).length,
        lastRun: null,
      });
    }
    const alerts = await alertsFor();
    return c.json({
      sources,
      alerts,
      alertSummary: summarizeAlerts(alerts),
      pipeline: await deps.store.getPipelineRuns(undefined, 20),
    });
  });

  /** Alerts on their own, for polling and for anything outside the dashboard. */
  app.get('/api/alerts', async (c) => {
    const alerts = await alertsFor();
    return c.json({ alerts, summary: summarizeAlerts(alerts), ts: new Date().toISOString() });
  });

  /**
   * Liveness plus a one-line verdict on the data.
   *
   * Stays 200 while the process is serving — a monitor asking "is the API up"
   * must not get a 503 because a feed is stale. `summary.critical` is the field
   * to alert on, and it is one hop away.
   */
  app.get('/api/health', async (c) => {
    const pipeline = await deps.store.getLatestPipelineRuns();
    const alerts = await alertsFor();
    return c.json({
      ok: true,
      ts: new Date().toISOString(),
      summary: summarizeAlerts(alerts),
      lastRun: pipeline[0] ?? null,
    });
  });

  return app;
}
