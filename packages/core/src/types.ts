/**
 * Core domain types.
 *
 * The organising idea of this codebase: every source, however exotic its wire
 * format (SDMX, ArcGIS, XML, CSV, JSON), is normalised into a stream of
 * `Observation` records. Storage, scoring, charting and staleness are then
 * written exactly once rather than once per source.
 */

/** ISO date, `YYYY-MM-DD`. */
export type IsoDate = string;

export type Cadence = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'irregular';

/**
 * The nine analytical groupings. These are the drill-down units in the UI and
 * the aggregation units in the scoring engine.
 */
export type Pillar =
  | 'monetary'   // A: debasement, money supply, gold, real rates
  | 'sovereign'  // B: government debt, curves, auctions, foreign demand
  | 'credit'     // C: spreads, repo, swap lines, bank health
  | 'realecon'   // D: employment, production, housing
  | 'trade'      // E: physical global trade flows
  | 'energy'     // F: oil, distillates, electricity
  | 'fx'         // G: exchange rates, reserves, de-dollarisation
  | 'markets'    // H: equities, volatility
  | 'narrative'; // I: news-derived event intensity

export const PILLARS: readonly Pillar[] = [
  'monetary', 'sovereign', 'credit', 'realecon', 'trade', 'energy', 'fx', 'markets', 'narrative',
] as const;

export const PILLAR_LABELS: Record<Pillar, string> = {
  monetary: 'Monetary Debasement',
  sovereign: 'Sovereign Debt & Bonds',
  credit: 'Credit & Plumbing',
  realecon: 'Real Economy',
  trade: 'Physical Trade',
  energy: 'Energy',
  fx: 'FX & Reserves',
  markets: 'Markets',
  narrative: 'Narrative & Events',
};

/** A single data point. The atom of the whole system. */
export interface Observation {
  seriesId: string;
  obsDate: IsoDate;
  value: number;
}

/** Metadata describing a series. Written by connectors on registration. */
export interface SeriesDef {
  id: string;
  name: string;
  unit: string;
  cadence: Cadence;
  sourceId: string;
  pillar: Pillar | null;
  sourceUrl?: string;
  notes?: string;
  /**
   * How many days without a fresh observation before this series is considered
   * stale. Set generously above the natural cadence: a monthly series published
   * with a 6-week lag needs ~50, not ~30.
   */
  stalenessBudgetDays: number;
}

/** A discrete newsworthy occurrence, as opposed to a numeric observation. */
export interface WorldEvent {
  id: string;
  ts: string;
  sourceId: string;
  category: string;
  headline: string;
  url: string;
  severity: number;
  entities?: string[];
}

export type RunStatus = 'ok' | 'partial' | 'error' | 'skipped';

export interface SourceRun {
  id?: number;
  sourceId: string;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  rowsWritten: number;
  eventsWritten: number;
  error: string | null;
}

export interface SeriesHealth {
  seriesId: string;
  lastObsDate: IsoDate | null;
  lastSuccessAt: string | null;
  stalenessBudgetDays: number;
  /** Days between `lastObsDate` and today. Null when there is no data at all. */
  ageDays: number | null;
  stale: boolean;
}

export type ScoreKind = 'indicator' | 'pillar' | 'composite' | 'watchlist';

export interface ScoreRecord {
  scoreDate: IsoDate;
  key: string;
  kind: ScoreKind;
  value: number;
  /**
   * The arithmetic that produced `value`, serialised. This is what makes the
   * model auditable in the UI — never write a score without it.
   */
  inputs: unknown;
}
