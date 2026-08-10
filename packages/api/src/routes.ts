import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  addDays, asOf as valueAsOfDate, BOARD, boardSeriesIds, computeComposite, computeQuoteStats,
  CURVE_POINTS, evaluateWatchlist, HEADLINE_ROWS, indexSeries, isRateUnit, loadScoringConfig, todayIso,
  type BoardRow, type Observation, type QuoteStats, type Store,
} from '@wd/core';
import { CONNECTORS } from '@wd/connectors';

export interface ApiDeps {
  store: Store;
  configPath: string;
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
      health: {
        totalSeries: health.length,
        staleSeries: staleSeries.length,
        // Surfaced in the UI because the user opted out of notifications:
        // a broken feed has to be visible on the page itself.
        stale: staleSeries.slice(0, 40),
        runs,
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
    return c.json({ sources });
  });

  app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

  return app;
}
