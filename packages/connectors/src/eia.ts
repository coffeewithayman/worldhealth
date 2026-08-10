import type { Cadence, Connector, ConnectorResult, FetchCtx, Observation, Pillar, SeriesDef } from '@wd/core';
import { isoDate, num } from './util.js';

interface EiaSeries {
  /** Legacy-style EIA series id, resolvable through the v2 `/seriesid/` route. */
  eia: string;
  id: string;
  name: string;
  unit: string;
  cadence: Cadence;
  pillar: Pillar;
  stalenessBudgetDays: number;
  notes?: string;
}

const CATALOG: EiaSeries[] = [
  // Prices. Duplicated from FRED deliberately — EIA is the primary publisher and
  // lands earlier; having both lets each cross-check the other.
  { eia: 'PET.RWTC.D', id: 'oil.wti_eia', name: 'WTI Cushing Spot Price', unit: 'USD per barrel', cadence: 'daily', pillar: 'energy', stalenessBudgetDays: 7 },
  { eia: 'PET.RBRTE.D', id: 'oil.brent_eia', name: 'Brent Europe Spot Price', unit: 'USD per barrel', cadence: 'daily', pillar: 'energy', stalenessBudgetDays: 7 },
  { eia: 'NG.RNGWHHD.D', id: 'gas.henry_hub_eia', name: 'Henry Hub Natural Gas Spot Price', unit: 'USD per MMBtu', cadence: 'daily', pillar: 'energy', stalenessBudgetDays: 7 },

  // Physical inventories — the part of the energy picture price alone hides.
  { eia: 'PET.WCESTUS1.W', id: 'oil.crude_stocks', name: 'US Crude Oil Stocks (excl. SPR)', unit: 'thousand barrels', cadence: 'weekly', pillar: 'energy', stalenessBudgetDays: 12 },
  { eia: 'PET.WCSSTUS1.W', id: 'oil.spr_stocks', name: 'US Strategic Petroleum Reserve', unit: 'thousand barrels', cadence: 'weekly', pillar: 'energy', stalenessBudgetDays: 12,
    notes: 'A drained SPR removes the shock absorber for the next energy disruption.' },
  { eia: 'PET.WDISTUS1.W', id: 'oil.distillate_stocks', name: 'US Distillate Fuel Oil Stocks', unit: 'thousand barrels', cadence: 'weekly', pillar: 'energy', stalenessBudgetDays: 12,
    notes: 'Diesel is what physically moves the economy. Thin distillate cover is a fragility signal that price alone does not show — it constrains freight, agriculture and construction simultaneously.' },
  { eia: 'PET.WGTSTUS1.W', id: 'oil.gasoline_stocks', name: 'US Total Gasoline Stocks', unit: 'thousand barrels', cadence: 'weekly', pillar: 'energy', stalenessBudgetDays: 12 },

  // Flows.
  { eia: 'PET.WCRFPUS2.W', id: 'oil.crude_production', name: 'US Crude Oil Field Production', unit: 'thousand barrels/day', cadence: 'weekly', pillar: 'energy', stalenessBudgetDays: 12 },
  { eia: 'PET.WPULEUS3.W', id: 'oil.refinery_utilization', name: 'US Refinery Utilization', unit: 'percent', cadence: 'weekly', pillar: 'energy', stalenessBudgetDays: 12,
    notes: 'Sustained low utilisation without a maintenance explanation indicates demand destruction.' },
  { eia: 'PET.WCRIMUS2.W', id: 'oil.crude_imports', name: 'US Crude Oil Imports', unit: 'thousand barrels/day', cadence: 'weekly', pillar: 'energy', stalenessBudgetDays: 12 },
  { eia: 'PET.WCREXUS2.W', id: 'oil.crude_exports', name: 'US Crude Oil Exports', unit: 'thousand barrels/day', cadence: 'weekly', pillar: 'energy', stalenessBudgetDays: 12 },
  { eia: 'PET.WRPUPUS2.W', id: 'oil.product_supplied', name: 'US Petroleum Products Supplied', unit: 'thousand barrels/day', cadence: 'weekly', pillar: 'energy', stalenessBudgetDays: 12,
    notes: 'The closest weekly read on real US oil demand.' },
];

interface SeriesIdResponse {
  response?: { data?: Array<{ period?: string; value?: unknown }> };
  error?: string;
}

interface RegionDataResponse {
  response?: { data?: Array<{ period?: string; value?: unknown }> };
  error?: string;
}

/**
 * US Energy Information Administration (API v2).
 *
 * Uses the v2 `/seriesid/` compatibility route rather than facet queries: it is
 * far more stable across API revisions and needs no per-dataset route knowledge.
 *
 * The electricity demand series is fetched separately and is arguably the most
 * interesting thing here — grid load is a real-time, unrevised measure of
 * economic activity, with none of the reporting lag that makes most macro data
 * a rear-view mirror.
 */
export const eiaConnector: Connector = {
  id: 'eia',
  name: 'US Energy Information Administration',
  homepage: 'https://www.eia.gov/opendata/documentation.php',
  cadence: 'daily',
  requiresKey: 'EIA_API_KEY',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    const key = ctx.env.EIA_API_KEY;
    if (!key) throw new Error('EIA_API_KEY is not set');

    const observations: Observation[] = [];
    const warnings: string[] = [];
    const ok: EiaSeries[] = [];

    const queue = [...CATALOG];
    const worker = async (): Promise<void> => {
      for (;;) {
        const s = queue.shift();
        if (!s) return;
        const url = `https://api.eia.gov/v2/seriesid/${s.eia}`
          + `?api_key=${encodeURIComponent(key)}`
          + `&start=${ctx.since.slice(0, s.cadence === 'daily' ? 10 : 10)}`;
        try {
          const res = await ctx.http.getJson<SeriesIdResponse>(url, { cacheTtlHours: 8 });
          if (!res || res.error) {
            warnings.push(`${s.eia}: ${res?.error ?? 'empty response'}`);
            continue;
          }
          let n = 0;
          for (const row of res.response?.data ?? []) {
            const date = isoDate(row.period);
            const v = num(row.value);
            if (!date || v === null || date < ctx.since) continue;
            observations.push({ seriesId: s.id, obsDate: date, value: v });
            n++;
          }
          if (n === 0) warnings.push(`${s.eia}: no observations since ${ctx.since}`);
          else ok.push(s);
        } catch (err) {
          warnings.push(`${s.eia}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    const series: SeriesDef[] = ok.map((s) => ({
      id: s.id,
      name: s.name,
      unit: s.unit,
      cadence: s.cadence,
      sourceId: 'eia',
      pillar: s.pillar,
      sourceUrl: 'https://www.eia.gov/opendata/',
      notes: s.notes,
      stalenessBudgetDays: s.stalenessBudgetDays,
    }));

    // Lower-48 electricity demand: a daily, unrevised pulse of real activity.
    try {
      const elecUrl = 'https://api.eia.gov/v2/electricity/rto/daily-region-data/data/'
        + `?api_key=${encodeURIComponent(key)}`
        + '&frequency=daily&data[0]=value'
        + '&facets[respondent][]=US48&facets[type][]=D'
        + `&start=${ctx.since}&sort[0][column]=period&sort[0][direction]=desc&length=5000`;
      const res = await ctx.http.getJson<RegionDataResponse>(elecUrl, { cacheTtlHours: 8 });
      let n = 0;
      for (const row of res?.response?.data ?? []) {
        const date = isoDate(row.period);
        const v = num(row.value);
        if (!date || v === null) continue;
        observations.push({ seriesId: 'us.electricity_demand', obsDate: date, value: v });
        n++;
      }
      if (n > 0) {
        series.push({
          id: 'us.electricity_demand',
          name: 'US Lower-48 Electricity Demand',
          unit: 'megawatthours',
          cadence: 'daily',
          sourceId: 'eia',
          pillar: 'realecon',
          sourceUrl: 'https://www.eia.gov/electricity/gridmonitor/',
          notes: 'Real-time economic activity with no reporting lag and no revisions. Weather-sensitive, so compare year-over-year rather than week-over-week.',
          stalenessBudgetDays: 5,
        });
      } else {
        warnings.push('electricity demand: no rows returned');
      }
    } catch (err) {
      warnings.push(`electricity demand: ${(err as Error).message}`);
    }

    ctx.log(`${series.length} series returned data`);
    if (series.length === 0) {
      throw new Error(`No EIA series returned data. First errors: ${warnings.slice(0, 3).join('; ')}`);
    }
    return { series, observations, warnings: warnings.length ? warnings : undefined };
  },
};
