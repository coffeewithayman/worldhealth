import type { Connector, ConnectorResult, FetchCtx, Observation, SeriesDef } from '@wd/core';
import { isoDate, num } from './util.js';

/**
 * LBMA publishes each benchmark as a plain JSON array:
 *   [{ "d": "2026-08-07", "v": [USD, GBP, EUR] }, ...]
 * The `v` triple is always in that currency order.
 */
const FILES: Array<{
  file: string;
  metal: string;
  id: string;
  name: string;
  notes?: string;
}> = [
  {
    file: 'gold_pm', metal: 'gold', id: 'metal.gold',
    name: 'LBMA Gold Price PM',
    notes: 'The world benchmark gold price, set twice daily in London. The PM fix is the settlement reference for most physical contracts.',
  },
  {
    file: 'gold_am', metal: 'gold_am', id: 'metal.gold_am',
    name: 'LBMA Gold Price AM',
  },
  {
    file: 'silver', metal: 'silver', id: 'metal.silver',
    name: 'LBMA Silver Price',
    notes: 'More industrial and more volatile than gold; the gold/silver ratio is a classic monetary-stress gauge.',
  },
  {
    file: 'platinum_pm', metal: 'platinum', id: 'metal.platinum',
    name: 'LBMA Platinum Price PM',
  },
  {
    file: 'palladium_pm', metal: 'palladium', id: 'metal.palladium',
    name: 'LBMA Palladium Price PM',
  },
];

interface LbmaRow { d?: string; v?: Array<number | null> }

/**
 * London Bullion Market Association benchmark prices.
 *
 * The anchor of the whole sound-money view, and pleasingly, entirely free: no
 * key, no rate limit, and unbroken daily history back to 1968 — which spans
 * the closing of the gold window, two oil shocks, Volcker, and 2008. That depth
 * is what makes the percentile-based scoring meaningful rather than decorative.
 *
 * Prices arrive in USD, GBP and EUR. Gold measured in the *other* thirty-odd
 * currencies is derived downstream from ECB cross rates — that derived set is
 * the debasement league table, and it answers the question this dashboard
 * exists for: not "is gold going up" but "which currencies are failing".
 */
export const lbmaMetalsConnector: Connector = {
  id: 'lbma-metals',
  name: 'LBMA Precious Metal Benchmark Prices',
  homepage: 'https://www.lbma.org.uk/prices-and-data/lbma-precious-metal-prices',
  cadence: 'daily',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    const observations: Observation[] = [];
    const series: SeriesDef[] = [];
    const warnings: string[] = [];

    for (const f of FILES) {
      let rows: LbmaRow[] | null;
      try {
        rows = await ctx.http.getJson<LbmaRow[]>(
          `https://prices.lbma.org.uk/json/${f.file}.json`,
          { cacheTtlHours: 8 },
        );
      } catch (err) {
        warnings.push(`${f.file}: ${(err as Error).message}`);
        continue;
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        warnings.push(`${f.file}: empty or unexpected payload`);
        continue;
      }

      const currencies = ['USD', 'GBP', 'EUR'] as const;
      const written = new Set<string>();

      for (const row of rows) {
        const date = isoDate(row.d);
        if (!date || date < ctx.since) continue;
        const vals = row.v ?? [];
        currencies.forEach((ccy, i) => {
          const v = num(vals[i]);
          // Pre-1999 rows carry null in the EUR slot; skip rather than zero-fill.
          if (v === null || v <= 0) return;
          const id = ccy === 'USD' ? f.id : `${f.id}.${ccy.toLowerCase()}`;
          observations.push({ seriesId: id, obsDate: date, value: v });
          written.add(id);
        });
      }

      for (const ccy of currencies) {
        const id = ccy === 'USD' ? f.id : `${f.id}.${ccy.toLowerCase()}`;
        if (!written.has(id)) continue;
        series.push({
          id,
          name: `${f.name} (${ccy})`,
          unit: `${ccy} per troy ounce`,
          cadence: 'daily',
          sourceId: 'lbma-metals',
          pillar: 'monetary',
          sourceUrl: 'https://www.lbma.org.uk/prices-and-data/lbma-precious-metal-prices',
          notes: f.notes,
          // London business days only, so a bank holiday weekend reaches 4.
          stalenessBudgetDays: 6,
        });
      }
      ctx.log(`${f.file}: ${written.size} currency series`);
    }

    if (series.length === 0) {
      throw new Error(`No LBMA benchmarks loaded. ${warnings.slice(0, 3).join('; ')}`);
    }
    return { series, observations, warnings: warnings.length ? warnings : undefined };
  },
};
