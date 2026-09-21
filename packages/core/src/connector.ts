import type { Http } from './http.js';
import type { Cadence, IsoDate, Observation, SeriesDef, WorldEvent } from './types.js';

export interface FetchCtx {
  /** Earliest date to fetch. Backfill passes a distant past; daily ingest passes ~90 days ago. */
  since: IsoDate;
  /**
   * Restrict the run to these series ids, when set. A hint, not a contract: a
   * source that fetches per series (FRED, EIA) honours it so backfilling one
   * new catalogue entry is one request rather than ninety; a source whose API
   * returns everything at once ignores it, and the extra rows are harmless.
   */
  seriesIds?: ReadonlySet<string>;
  today: IsoDate;
  http: Http;
  env: NodeJS.ProcessEnv;
  log: (msg: string) => void;
}

export interface ConnectorResult {
  /** Series metadata. Connectors declare their own series so the registry stays local to the source. */
  series: SeriesDef[];
  observations: Observation[];
  events?: WorldEvent[];
  /** Non-fatal problems: a sub-series 404'd but the rest succeeded. Surfaces as `partial`. */
  warnings?: string[];
}

export interface Connector {
  id: string;
  name: string;
  /** Human-facing documentation URL, shown in the UI next to the data. */
  homepage: string;
  cadence: Cadence;
  /** Env var holding the API key, when one is needed. */
  requiresKey?: string;
  /**
   * True when this source is expected to be flaky or paywalled (unofficial
   * endpoints, scraped press releases, paid indices). Optional connectors
   * failing degrades a panel; required connectors failing is a real problem.
   */
  optional?: boolean;
  /** One-line note on caveats, e.g. "daily data but refreshed weekly on Tuesdays". */
  caveat?: string;
  run(ctx: FetchCtx): Promise<ConnectorResult>;
}

/** Convenience for the common case of building a SeriesDef with shared defaults. */
export function defineSeries(
  base: Pick<SeriesDef, 'sourceId' | 'cadence' | 'stalenessBudgetDays'> & Partial<SeriesDef>,
  entries: Array<Pick<SeriesDef, 'id' | 'name' | 'unit' | 'pillar'> & Partial<SeriesDef>>,
): SeriesDef[] {
  return entries.map((e) => ({
    sourceUrl: base.sourceUrl,
    notes: base.notes,
    ...base,
    ...e,
  } as SeriesDef));
}
