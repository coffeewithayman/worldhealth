import type {
  IsoDate, Observation, PipelineRun, PipelineStage, ScoreRecord, SeriesDef, SeriesHealth,
  SourceRun, WorldEvent,
} from './types.js';

export interface SeriesFilter {
  pillar?: string;
  sourceId?: string;
}

export interface EventFilter {
  category?: string;
  since?: string;
  limit?: number;
}

/**
 * Storage abstraction.
 *
 * Every method is async even though the local SQLite implementation is
 * synchronous. That is deliberate: D1 and Postgres are async, and having the
 * call sites already await means swapping the implementation is a one-file
 * change rather than a refactor of every caller.
 */
export interface Store {
  /** Apply every pending migration. Idempotent and safe to run concurrently. */
  migrate(): Promise<void>;
  /** Cheapest possible round trip — what a liveness probe calls. */
  ping(): Promise<void>;

  upsertSeries(defs: SeriesDef[]): Promise<void>;
  listSeries(filter?: SeriesFilter): Promise<SeriesDef[]>;
  getSeries(id: string): Promise<SeriesDef | null>;

  /** Idempotent: re-ingesting the same window overwrites rather than duplicates. */
  putObservations(obs: Observation[]): Promise<number>;
  getObservations(seriesId: string, from?: IsoDate, to?: IsoDate): Promise<Observation[]>;
  getLatestObservation(seriesId: string): Promise<Observation | null>;
  /** Latest observation for many series at once — avoids N queries when scoring. */
  getLatestObservations(seriesIds: string[]): Promise<Map<string, Observation>>;

  recordRun(run: SourceRun): Promise<void>;
  getLatestRuns(): Promise<SourceRun[]>;

  recordPipelineRun(run: PipelineRun): Promise<void>;
  /** The most recent run of each stage — what "is the updater alive" is read from. */
  getLatestPipelineRuns(): Promise<PipelineRun[]>;
  getPipelineRuns(stage?: PipelineStage, limit?: number): Promise<PipelineRun[]>;

  markSeriesSuccess(seriesIds: string[], at: string): Promise<void>;
  getSeriesHealth(): Promise<SeriesHealth[]>;

  /**
   * Series whose deep history has been loaded. A series missing from this set
   * is fetched from `since` 25 years back on the next `daily` — which is how a
   * source or catalogue entry added in code fills itself in production.
   */
  getBackfilledSeries(): Promise<Set<string>>;
  markBackfilled(seriesIds: string[], at: string, since: IsoDate): Promise<void>;

  putScores(scores: ScoreRecord[]): Promise<void>;
  getScores(scoreDate: IsoDate): Promise<ScoreRecord[]>;
  getLatestScoreDate(): Promise<IsoDate | null>;
  getScoreHistory(key: string, from?: IsoDate): Promise<Array<{ scoreDate: IsoDate; value: number }>>;

  putEvents(events: WorldEvent[]): Promise<number>;
  listEvents(filter?: EventFilter): Promise<WorldEvent[]>;

  close(): Promise<void>;
}
