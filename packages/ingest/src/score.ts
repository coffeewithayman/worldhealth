import {
  computeComposite, evaluateWatchlist, loadScoringConfig, todayIso,
  type CompositeScore, type Observation, type ScoreRecord, type Store, type WatchlistResult,
} from '@wd/core';
import { resolve } from 'node:path';
import { ROOT } from './config.js';

export interface ScoreOutcome {
  composite: CompositeScore;
  watchlist: WatchlistResult[];
}

export function configPath(): string {
  return process.env.WD_CONFIG_PATH ?? resolve(ROOT, 'config/indicators.yaml');
}

/**
 * Load every series referenced by the config or watchlist into memory.
 *
 * Loading whole series rather than recent windows is deliberate: percentile
 * transforms rank the current value against decades of history, so the history
 * is the input, not an optimisation detail.
 */
async function loadSeriesData(store: Store, ids: string[]): Promise<Map<string, Observation[]>> {
  const data = new Map<string, Observation[]>();
  for (const id of new Set(ids)) {
    const obs = await store.getObservations(id);
    if (obs.length > 0) data.set(id, obs);
  }
  return data;
}

/** Series the watchlist rules read beyond those already in the indicator config. */
const WATCHLIST_SERIES = [
  'ust.spread.10y2y', 'd.curve_steepening_90d', 'us.hy_oas', 'd.m2_yoy',
  'd.bank_credit_yoy', 'us.sahm_rule', 'us.cb_liquidity_swaps',
  'd.auction_dealer_avg', 'em.sovereign_oas', 'd.sofr_iorb', 'd.gold_breadth',
];

export async function computeAndStoreScores(
  store: Store,
  asOfDate: string = todayIso(),
  persist = true,
): Promise<ScoreOutcome> {
  const config = loadScoringConfig(configPath());
  const ids = [...config.indicators.map((i) => i.seriesId), ...WATCHLIST_SERIES];
  const data = await loadSeriesData(store, ids);

  const composite = computeComposite(config.indicators, data, asOfDate, {
    pillarWeights: config.pillarWeights,
  });
  const watchlist = evaluateWatchlist(data, asOfDate);

  if (persist) {
    const records: ScoreRecord[] = [];

    records.push({
      scoreDate: asOfDate,
      key: 'composite',
      kind: 'composite',
      value: Number.isFinite(composite.score) ? composite.score : 0,
      inputs: {
        regime: composite.regime,
        pillarsElevated: composite.pillarsElevated,
        coverage: composite.coverage,
        pillarWeights: config.pillarWeights,
        pillars: composite.pillars.map((p) => ({
          pillar: p.pillar, score: p.score, coverage: p.coverage, indicatorCount: p.indicators.length,
        })),
      },
    });

    for (const p of composite.pillars) {
      if (!Number.isFinite(p.score)) continue;
      records.push({
        scoreDate: asOfDate,
        key: `pillar.${p.pillar}`,
        kind: 'pillar',
        value: p.score,
        inputs: { coverage: p.coverage, missing: p.missing, indicators: p.indicators },
      });
      for (const ind of p.indicators) {
        records.push({
          scoreDate: asOfDate,
          key: `indicator.${ind.seriesId}`,
          kind: 'indicator',
          value: ind.score,
          // The arithmetic travels with the score so the UI never has to guess.
          inputs: {
            label: ind.label, rawValue: ind.rawValue, obsDate: ind.obsDate,
            weight: ind.weight, transform: ind.transform, explanation: ind.explanation,
          },
        });
      }
    }

    for (const w of watchlist) {
      records.push({
        scoreDate: asOfDate,
        key: `watch.${w.id}`,
        kind: 'watchlist',
        value: w.available ? w.severity : 0,
        inputs: { name: w.name, triggered: w.triggered, detail: w.detail, available: w.available, rationale: w.rationale },
      });
    }

    await store.putScores(records);
  }

  return { composite, watchlist };
}
