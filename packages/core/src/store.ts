import type {
  IsoDate, Observation, ScoreRecord, SeriesDef, SeriesHealth, SourceRun, WorldEvent,
} from './types.js';

export interface CachedResponse {
  cacheKey: string;
  sourceId: string;
  url: string;
  fetchedAt: string;
  body: string;
}

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
  migrate(): Promise<void>;

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

  markSeriesSuccess(seriesIds: string[], at: string): Promise<void>;
  getSeriesHealth(): Promise<SeriesHealth[]>;

  putScores(scores: ScoreRecord[]): Promise<void>;
  getScores(scoreDate: IsoDate): Promise<ScoreRecord[]>;
  getLatestScoreDate(): Promise<IsoDate | null>;
  getScoreHistory(key: string, from?: IsoDate): Promise<Array<{ scoreDate: IsoDate; value: number }>>;

  putEvents(events: WorldEvent[]): Promise<number>;
  listEvents(filter?: EventFilter): Promise<WorldEvent[]>;

  cacheGet(cacheKey: string): Promise<CachedResponse | null>;
  cachePut(entry: CachedResponse): Promise<void>;

  close(): Promise<void>;
}
