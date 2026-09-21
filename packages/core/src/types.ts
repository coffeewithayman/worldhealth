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
  /**
   * The date of the last observation the upstream will ever publish, for a
   * series that has been discontinued.
   *
   * A retired series is finished, not broken, and the difference matters: its
   * history stays queryable for backtests, but it must stop counting as stale
   * or it raises an alert every day forever whose age only ever grows — which
   * is exactly the alert that trains a reader to ignore the list.
   */
  retiredAt?: IsoDate;
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

/** The stages a scheduler runs. `daily` wraps ingest → derive → score. */
export type PipelineStage = 'ingest' | 'backfill' | 'derive' | 'score' | 'daily';

/**
 * One execution of a pipeline stage.
 *
 * `source_runs` answers "is this feed working". This answers the question a
 * source-by-source view cannot: did the update run at all? A scheduler that
 * stopped firing leaves every source row looking exactly as healthy as it did
 * the day it died, which is the failure this table exists to make visible.
 */
export interface PipelineRun {
  id?: number;
  stage: PipelineStage;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  /** Units of work that succeeded and failed — connectors, or derivations. */
  okCount: number;
  failCount: number;
  rowsWritten: number;
  /** Set when the stage itself threw, as opposed to individual units failing. */
  error: string | null;
  /** Stage-specific JSON: the failing unit ids, the composite score, and so on. */
  detail: unknown;
}

export interface SeriesHealth {
  seriesId: string;
  lastObsDate: IsoDate | null;
  lastSuccessAt: string | null;
  stalenessBudgetDays: number;
  /** Days between `lastObsDate` and today. Null when there is no data at all. */
  ageDays: number | null;
  stale: boolean;
  /**
   * Set when the upstream has discontinued the series. Retired series are
   * never `stale` — there is no fix, so an alert naming one would have no
   * command to put under it.
   */
  retired: boolean;
  retiredAt: IsoDate | null;
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
