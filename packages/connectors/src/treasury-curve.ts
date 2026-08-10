import type { Connector, ConnectorResult, FetchCtx, Observation, SeriesDef } from '@wd/core';
import { csvToObjects, isoDate, num } from './util.js';

/** CSV column header -> our series suffix and display tenor. */
const TENORS: Array<{ col: string; key: string; label: string }> = [
  { col: '1 Mo', key: '1m', label: '1-Month' },
  { col: '2 Mo', key: '2m', label: '2-Month' },
  { col: '3 Mo', key: '3m', label: '3-Month' },
  { col: '4 Mo', key: '4m', label: '4-Month' },
  { col: '6 Mo', key: '6m', label: '6-Month' },
  { col: '1 Yr', key: '1y', label: '1-Year' },
  { col: '2 Yr', key: '2y', label: '2-Year' },
  { col: '3 Yr', key: '3y', label: '3-Year' },
  { col: '5 Yr', key: '5y', label: '5-Year' },
  { col: '7 Yr', key: '7y', label: '7-Year' },
  { col: '10 Yr', key: '10y', label: '10-Year' },
  { col: '20 Yr', key: '20y', label: '20-Year' },
  { col: '30 Yr', key: '30y', label: '30-Year' },
];

function urlForYear(year: number): string {
  return 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv'
    + `/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
}

/**
 * US Treasury daily par yield curve.
 *
 * Taken straight from Treasury rather than via FRED so the curve works with no
 * API key at all, and so the full curve arrives in one request per year rather
 * than one per tenor.
 *
 * Emits the raw tenors plus the two spreads that matter most. On the 10y-2y:
 * the recession signal historically fires not when the curve inverts but when
 * a deep inversion *re-steepens*, so the scoring layer watches the rate of
 * change of this series, not just its sign.
 */
export const treasuryCurveConnector: Connector = {
  id: 'treasury-curve',
  name: 'US Treasury Daily Par Yield Curve',
  homepage: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve',
  cadence: 'daily',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    const startYear = Number(ctx.since.slice(0, 4));
    const endYear = Number(ctx.today.slice(0, 4));
    const observations: Observation[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    for (let year = startYear; year <= endYear; year++) {
      // Prior years are immutable; only the current year needs frequent refetching.
      const ttl = year === endYear ? 6 : 24 * 30;
      let body: string | null;
      try {
        body = await ctx.http.getText(urlForYear(year), { cacheTtlHours: ttl, emptyOn: [404] });
      } catch (err) {
        warnings.push(`year ${year}: ${(err as Error).message}`);
        continue;
      }
      if (!body || !body.includes('Date')) {
        warnings.push(`year ${year}: no CSV returned`);
        continue;
      }

      for (const row of csvToObjects(body)) {
        const date = isoDate(row.Date);
        if (!date || date < ctx.since) continue;

        const byKey = new Map<string, number>();
        for (const t of TENORS) {
          const v = num(row[t.col]);
          if (v === null) continue;
          byKey.set(t.key, v);
          observations.push({ seriesId: `ust.yield.${t.key}`, obsDate: date, value: v });
          seen.add(`ust.yield.${t.key}`);
        }

        // Curve spreads, in basis points.
        const y10 = byKey.get('10y');
        const y2 = byKey.get('2y');
        const m3 = byKey.get('3m');
        const y30 = byKey.get('30y');
        const y5 = byKey.get('5y');

        if (y10 !== undefined && y2 !== undefined) {
          observations.push({ seriesId: 'ust.spread.10y2y', obsDate: date, value: (y10 - y2) * 100 });
          seen.add('ust.spread.10y2y');
        }
        if (y10 !== undefined && m3 !== undefined) {
          observations.push({ seriesId: 'ust.spread.10y3m', obsDate: date, value: (y10 - m3) * 100 });
          seen.add('ust.spread.10y3m');
        }
        if (y30 !== undefined && y5 !== undefined) {
          observations.push({ seriesId: 'ust.spread.30y5y', obsDate: date, value: (y30 - y5) * 100 });
          seen.add('ust.spread.30y5y');
        }
      }
      ctx.log(`year ${year}: ${observations.length} observations so far`);
    }

    if (observations.length === 0) {
      throw new Error('Treasury returned no yield curve rows for the requested range');
    }

    return { series: buildSeriesDefs(seen), observations, warnings };
  },
};

function buildSeriesDefs(seen: Set<string>): SeriesDef[] {
  const base = {
    sourceId: 'treasury-curve',
    cadence: 'daily' as const,
    stalenessBudgetDays: 5,
    pillar: 'sovereign' as const,
    sourceUrl: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve',
  };
  const defs: SeriesDef[] = [];

  for (const t of TENORS) {
    if (seen.has(`ust.yield.${t.key}`)) {
      defs.push({
        ...base,
        id: `ust.yield.${t.key}`,
        name: `US Treasury ${t.label} Par Yield`,
        unit: 'percent',
      });
    }
  }

  const spreads: Array<[string, string, string]> = [
    ['ust.spread.10y2y', '10Y-2Y Treasury Spread',
      'The classic recession signal. Watch the re-steepening from a deep inversion, not the inversion itself.'],
    ['ust.spread.10y3m', '10Y-3M Treasury Spread',
      'The NY Fed recession-probability model uses this tenor pair rather than 10y-2y.'],
    ['ust.spread.30y5y', '30Y-5Y Treasury Spread',
      'Long-end steepening signals term-premium and fiscal-credibility stress.'],
  ];
  for (const [id, name, notes] of spreads) {
    if (seen.has(id)) {
      defs.push({ ...base, id, name, unit: 'basis points', notes });
    }
  }
  return defs;
}
