import type { Connector, ConnectorResult, FetchCtx, Observation, Pillar, SeriesDef } from '@wd/core';

interface Coin {
  coin: string;
  /** Which of the two payload arrays carries the signal for this asset. */
  metric: 'price' | 'market_cap';
  id: string;
  name: string;
  unit: string;
  pillar: Pillar;
  notes?: string;
}

const COINS: Coin[] = [
  {
    coin: 'bitcoin', metric: 'price', id: 'crypto.btc', name: 'Bitcoin', unit: 'USD', pillar: 'monetary',
    notes: 'Tracked as a parallel monetary canary. A fixed-supply asset bid up by the same debasement anxiety that drives gold, but held by a different population — when both rise together, the signal is about the currency, not the asset.',
  },
  {
    coin: 'ethereum', metric: 'price', id: 'crypto.eth', name: 'Ethereum', unit: 'USD', pillar: 'markets',
    notes: 'Behaves as a high-beta risk asset; useful as a liquidity gauge rather than a monetary one.',
  },
  {
    coin: 'tether', metric: 'market_cap', id: 'crypto.usdt_supply', name: 'Tether (USDT) Supply', unit: 'USD', pillar: 'fx',
    notes: 'Stablecoin supply is a live proxy for offshore dollar demand — a modern, visible slice of the eurodollar system. Contraction signals dollar funding stress outside the banking system, which official statistics miss entirely.',
  },
  {
    coin: 'usd-coin', metric: 'market_cap', id: 'crypto.usdc_supply', name: 'USD Coin (USDC) Supply', unit: 'USD', pillar: 'fx',
    notes: 'The more regulated half of the stablecoin float; divergence from USDT supply indicates a flight to perceived quality.',
  },
];

interface MarketChart {
  prices?: Array<[number, number]>;
  market_caps?: Array<[number, number]>;
}

/**
 * CoinGecko market data.
 *
 * Included for two distinct reasons. Bitcoin is a sound-money instrument whose
 * bid reflects the same debasement anxiety as gold. Stablecoin supply is
 * something else entirely: a real-time window onto offshore dollar demand,
 * which is otherwise visible only in quarterly BIS statistics published months
 * late.
 *
 * Works without a key. `COINGECKO_API_KEY` is honoured if present, which raises
 * the rate limit and extends the available history.
 */
export const coingeckoConnector: Connector = {
  id: 'coingecko',
  name: 'CoinGecko',
  homepage: 'https://www.coingecko.com/en/api/documentation',
  cadence: 'daily',
  optional: true,
  caveat: 'Free tier limits history to roughly the last year; deep backfill needs a key.',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    const key = ctx.env.COINGECKO_API_KEY;
    const observations: Observation[] = [];
    const series: SeriesDef[] = [];
    const warnings: string[] = [];

    const requestedDays = Math.max(
      1,
      Math.ceil((Date.parse(`${ctx.today}T00:00:00Z`) - Date.parse(`${ctx.since}T00:00:00Z`)) / 86_400_000),
    );
    // The public tier silently truncates beyond ~365 days; asking for more just
    // wastes the request.
    const days = key ? requestedDays : Math.min(requestedDays, 365);

    for (const c of COINS) {
      const url = `https://api.coingecko.com/api/v3/coins/${c.coin}/market_chart`
        + `?vs_currency=usd&days=${days}&interval=daily`;
      try {
        const res = await ctx.http.getJson<MarketChart>(url, {
          cacheTtlHours: 8,
          headers: key ? { 'x-cg-demo-api-key': key } : {},
        });
        const rows = (c.metric === 'price' ? res?.prices : res?.market_caps) ?? [];
        if (rows.length === 0) { warnings.push(`${c.coin}: no ${c.metric} data`); continue; }

        // CoinGecko returns one point per UTC day plus a live intraday point;
        // keying by date means the live point overwrites the day's close rather
        // than creating a duplicate.
        const byDate = new Map<string, number>();
        for (const [ms, v] of rows) {
          if (!Number.isFinite(v)) continue;
          byDate.set(new Date(ms).toISOString().slice(0, 10), v);
        }
        for (const [date, value] of byDate) {
          if (date < ctx.since) continue;
          observations.push({ seriesId: c.id, obsDate: date, value });
        }

        series.push({
          id: c.id,
          name: c.name,
          unit: c.unit,
          cadence: 'daily',
          sourceId: 'coingecko',
          pillar: c.pillar,
          sourceUrl: `https://www.coingecko.com/en/coins/${c.coin}`,
          notes: c.notes,
          // Crypto trades every day, so anything beyond 2 days is a real fault.
          stalenessBudgetDays: 3,
        });
      } catch (err) {
        warnings.push(`${c.coin}: ${(err as Error).message}`);
      }
    }

    ctx.log(`${series.length}/${COINS.length} coins loaded`);
    if (series.length === 0) {
      throw new Error(`CoinGecko returned no data. ${warnings.slice(0, 2).join('; ')}`);
    }
    return { series, observations, warnings: warnings.length ? warnings : undefined };
  },
};
