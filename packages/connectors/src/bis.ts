import type { Connector, ConnectorResult, FetchCtx, Observation, SeriesDef } from '@wd/core';
import { csvToObjects, isoDate, num } from './util.js';

/** Economies tracked for property prices and credit gaps. */
const AREAS: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', DE: 'Germany', FR: 'France',
  IT: 'Italy', ES: 'Spain', NL: 'Netherlands', SE: 'Sweden', CH: 'Switzerland',
  JP: 'Japan', CN: 'China', KR: 'South Korea', AU: 'Australia', CA: 'Canada',
  IN: 'India', BR: 'Brazil', TR: 'Turkey', ZA: 'South Africa',
};

/**
 * Bank for International Settlements.
 *
 * Two datasets, both of which the BIS itself designed as crisis early-warning
 * tools:
 *
 *  - **Real residential property prices** — inflation-adjusted, and therefore
 *    comparable across countries and across decades in a way nominal prices
 *    are not.
 *  - **Credit-to-GDP gap** — private credit relative to its own long-run trend.
 *    The BIS uses this as its headline indicator for systemic banking crises,
 *    and gaps above roughly 10 percentage points have preceded most of them.
 *
 * Both are quarterly and published with a substantial lag, so they are context
 * rather than early warning at daily resolution — but they are the best
 * cross-country view of property and leverage that exists for free.
 */
export const bisConnector: Connector = {
  id: 'bis',
  name: 'BIS — Property Prices & Credit Gaps',
  homepage: 'https://data.bis.org/',
  cadence: 'quarterly',
  caveat: 'Quarterly data published with a one-to-two quarter lag. Context, not early warning.',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    const observations: Observation[] = [];
    const series: SeriesDef[] = [];
    const warnings: string[] = [];
    const start = ctx.since.slice(0, 4);

    // --- Real residential property prices (WS_SPP, R = real, 628 = index) ---
    for (const [area, label] of Object.entries(AREAS)) {
      const url = `https://stats.bis.org/api/v2/data/dataflow/BIS/WS_SPP/1.0/Q.${area}.R.628`
        + `?format=csv&startPeriod=${start}`;
      try {
        const body = await ctx.http.getText(url, { cacheTtlHours: 24 * 7, emptyOn: [404, 400] });
        if (!body || !body.includes('TIME_PERIOD')) { warnings.push(`property ${area}: no data`); continue; }
        let n = 0;
        for (const row of csvToObjects(body)) {
          const date = isoDate(row.TIME_PERIOD);
          const v = num(row.OBS_VALUE);
          if (!date || v === null) continue;
          observations.push({ seriesId: `property.real.${area.toLowerCase()}`, obsDate: date, value: v });
          n++;
        }
        if (n === 0) { warnings.push(`property ${area}: no observations`); continue; }
        series.push({
          id: `property.real.${area.toLowerCase()}`,
          name: `Real Residential Property Prices — ${label}`,
          unit: 'index (2010=100)',
          cadence: 'quarterly',
          sourceId: 'bis',
          pillar: 'realecon',
          sourceUrl: 'https://data.bis.org/topics/RPP',
          notes: 'Inflation-adjusted, so cross-country and cross-decade comparisons are meaningful. Property busts are the most reliable precursor of banking crises.',
          // Quarterly, but publication lag varies a lot by country — Japan and
          // the Netherlands routinely run ~10 months behind. 330 days covers the
          // slowest reporters without masking a genuinely dead feed.
          stalenessBudgetDays: 330,
        });
      } catch (err) {
        warnings.push(`property ${area}: ${(err as Error).message}`);
      }
    }

    // --- Credit-to-GDP gaps (WS_CREDIT_GAP, private non-financial sector) ---
    for (const [area, label] of Object.entries(AREAS)) {
      const url = `https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CREDIT_GAP/1.0/Q.${area}.P.A.G`
        + `?format=csv&startPeriod=${start}`;
      try {
        const body = await ctx.http.getText(url, { cacheTtlHours: 24 * 7, emptyOn: [404, 400] });
        if (!body || !body.includes('TIME_PERIOD')) continue;
        let n = 0;
        for (const row of csvToObjects(body)) {
          const date = isoDate(row.TIME_PERIOD);
          const v = num(row.OBS_VALUE);
          if (!date || v === null) continue;
          observations.push({ seriesId: `credit_gap.${area.toLowerCase()}`, obsDate: date, value: v });
          n++;
        }
        if (n === 0) continue;
        series.push({
          id: `credit_gap.${area.toLowerCase()}`,
          name: `Credit-to-GDP Gap — ${label}`,
          unit: 'percentage points',
          cadence: 'quarterly',
          sourceId: 'bis',
          pillar: 'credit',
          sourceUrl: 'https://data.bis.org/topics/CREDIT_GAPS',
          notes: 'Private credit relative to its own long-run trend. The BIS treats gaps above ~10pp as a systemic banking-crisis warning.',
          stalenessBudgetDays: 240,
        });
      } catch (err) {
        warnings.push(`credit gap ${area}: ${(err as Error).message}`);
      }
    }

    ctx.log(`${series.length} BIS series`);
    if (series.length === 0) {
      throw new Error(`BIS returned no data. ${warnings.slice(0, 3).join('; ')}`);
    }
    return { series, observations, warnings: warnings.length ? warnings : undefined };
  },
};
