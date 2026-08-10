import type { Connector, ConnectorResult, FetchCtx, Observation, SeriesDef } from '@wd/core';
import { isoDate, num } from './util.js';

const CHOKEPOINTS_URL =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';

/**
 * The chokepoints worth scoring, and why each matters. A disruption at any of
 * these is a physical constraint on world trade that no amount of monetary
 * policy can relieve.
 */
const TRACKED: Record<string, { id: string; note: string }> = {
  'Suez Canal': { id: 'suez', note: 'Roughly 12% of global trade. The 2023-24 Red Sea diversions added ~10 days to Asia-Europe voyages.' },
  'Panama Canal': { id: 'panama', note: 'Drought-sensitive: transit limits during low water on Gatun Lake directly constrain US east-coast supply.' },
  'Strait of Hormuz': { id: 'hormuz', note: 'Around a fifth of global oil consumption passes through. The single most consequential energy chokepoint on earth.' },
  'Malacca Strait': { id: 'malacca', note: 'The main Asia-Middle East artery and the primary route for Chinese energy imports.' },
  'Bab el-Mandeb Strait': { id: 'bab_el_mandeb', note: 'The Red Sea approach to Suez; the first point to register Houthi-related disruption.' },
  'Bosporus Strait': { id: 'bosporus', note: 'Black Sea grain and Russian oil exports.' },
  'Gibraltar Strait': { id: 'gibraltar', note: 'Mediterranean-Atlantic gateway.' },
  'Cape of Good Hope': {
    id: 'good_hope',
    note: 'The Suez bypass. Traffic here rises as Suez falls, so the pair separates a genuine collapse in trade volume from a mere rerouting — a distinction a single chokepoint cannot make.',
  },
  'Korea Strait': { id: 'korea', note: 'North Asian manufacturing exports; an early read on the global trade cycle.' },
  'Taiwan Strait': { id: 'taiwan_strait', note: 'Carries a large share of container traffic and sits on the most significant geopolitical fault line in global trade.' },
  'Dover Strait': { id: 'dover', note: 'Northern European trade artery.' },
};

interface Feature {
  attributes?: {
    date?: string | number;
    portname?: string;
    n_total?: number;
    capacity?: number;
    n_tanker?: number;
    n_container?: number;
  };
}

/**
 * IMF PortWatch — daily maritime chokepoint transits from satellite AIS.
 *
 * The most genuinely outside-the-box source in the dashboard. Financial data
 * can be managed, smoothed or revised; ships either sail through the Strait of
 * Hormuz or they do not. This is a direct physical observation of world trade
 * with no reporting agency between the satellite and the number.
 *
 * Caveat that the UI must respect: the data has daily *granularity* but IMF
 * refreshes it weekly, on Tuesdays. The staleness budget below is set
 * accordingly so a normal mid-week gap is not reported as a broken feed.
 */
export const portwatchConnector: Connector = {
  id: 'imf-portwatch',
  name: 'IMF PortWatch — Maritime Chokepoints',
  homepage: 'https://portwatch.imf.org/',
  cadence: 'daily',
  caveat: 'Daily granularity but refreshed weekly (Tuesdays) — expect the latest point to be several days old.',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    const observations: Observation[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    // The service advertises maxRecordCount = 1000 and silently caps anything
    // larger. Requesting more than the cap makes a "short page" look like the
    // last page, which truncates the fetch after a single request — so the page
    // size must match the server's cap, and `exceededTransferLimit` is the
    // authoritative signal for whether more remains.
    const pageSize = 1000;
    let offset = 0;
    let fetched = 0;

    for (let page = 0; page < 200; page++) {
      const url = `${CHOKEPOINTS_URL}?where=${encodeURIComponent(`date >= DATE '${ctx.since}'`)}`
        + '&outFields=date,portname,n_total,capacity,n_tanker,n_container'
        + `&orderByFields=${encodeURIComponent('date ASC')}`
        + `&resultOffset=${offset}&resultRecordCount=${pageSize}&f=json`;

      let json: { features?: Feature[]; error?: unknown; exceededTransferLimit?: boolean } | null;
      try {
        json = await ctx.http.getJson<{ features?: Feature[]; error?: unknown; exceededTransferLimit?: boolean }>(
          url, { cacheTtlHours: 24 },
        );
      } catch (err) {
        warnings.push(`page ${page}: ${(err as Error).message}`);
        break;
      }
      if (!json || json.error) { warnings.push(`page ${page}: ArcGIS error`); break; }

      const features = json.features ?? [];
      if (features.length === 0) break;
      fetched += features.length;

      for (const f of features) {
        const a = f.attributes;
        if (!a?.portname) continue;
        const meta = TRACKED[a.portname];
        if (!meta) continue;
        // ArcGIS date-only fields come back as either an ISO string or epoch ms.
        const date = typeof a.date === 'number'
          ? new Date(a.date).toISOString().slice(0, 10)
          : isoDate(a.date);
        if (!date) continue;

        const transits = num(a.n_total);
        if (transits !== null) {
          observations.push({ seriesId: `trade.chokepoint.${meta.id}.transits`, obsDate: date, value: transits });
          seen.add(`trade.chokepoint.${meta.id}.transits`);
        }
        const capacity = num(a.capacity);
        if (capacity !== null) {
          observations.push({ seriesId: `trade.chokepoint.${meta.id}.capacity`, obsDate: date, value: capacity });
          seen.add(`trade.chokepoint.${meta.id}.capacity`);
        }
      }

      if (json.exceededTransferLimit !== true && features.length < pageSize) break;
      offset += features.length;
    }

    ctx.log(`fetched ${fetched} chokepoint records`);
    if (seen.size === 0) {
      throw new Error(`PortWatch returned no usable records. ${warnings.slice(0, 2).join('; ')}`);
    }

    const series: SeriesDef[] = [];
    for (const [name, meta] of Object.entries(TRACKED)) {
      const tId = `trade.chokepoint.${meta.id}.transits`;
      const cId = `trade.chokepoint.${meta.id}.capacity`;
      const base = {
        cadence: 'daily' as const,
        sourceId: 'imf-portwatch',
        pillar: 'trade' as const,
        sourceUrl: 'https://portwatch.imf.org/pages/port-monitor',
        // Weekly refresh of daily data: 12 days tolerates one missed cycle.
        stalenessBudgetDays: 12,
      };
      if (seen.has(tId)) {
        series.push({ ...base, id: tId, name: `${name} — Daily Transits`, unit: 'vessels', notes: meta.note });
      }
      if (seen.has(cId)) {
        series.push({
          ...base, id: cId, name: `${name} — Daily Transit Capacity`, unit: 'deadweight tonnes',
          notes: `${meta.note} Capacity is the better volume measure — vessel counts miss changes in ship size.`,
        });
      }
    }

    return { series, observations, warnings: warnings.length ? warnings : undefined };
  },
};
