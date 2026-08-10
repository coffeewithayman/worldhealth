import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_STATEMENTS } from './schema.js';
import type { CachedResponse, EventFilter, SeriesFilter, Store } from './store.js';
import type {
  Cadence, IsoDate, Observation, Pillar, ScoreKind, ScoreRecord,
  SeriesDef, SeriesHealth, SourceRun, WorldEvent,
} from './types.js';
import { daysBetween, todayIso } from './dates.js';

interface SeriesRow {
  id: string; name: string; unit: string; cadence: string; source_id: string;
  pillar: string | null; source_url: string | null; notes: string | null;
  staleness_budget_days: number;
}

function toSeriesDef(r: SeriesRow): SeriesDef {
  return {
    id: r.id,
    name: r.name,
    unit: r.unit,
    cadence: r.cadence as Cadence,
    sourceId: r.source_id,
    pillar: (r.pillar as Pillar | null) ?? null,
    sourceUrl: r.source_url ?? undefined,
    notes: r.notes ?? undefined,
    stalenessBudgetDays: r.staleness_budget_days,
  };
}

/**
 * The only file that knows we are on SQLite. Everything else talks to `Store`.
 */
export class SqliteStore implements Store {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL keeps the dashboard readable while a long backfill is writing.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  async migrate(): Promise<void> {
    for (const stmt of SCHEMA_STATEMENTS) this.db.exec(stmt);
  }

  async upsertSeries(defs: SeriesDef[]): Promise<void> {
    if (defs.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO series (id, name, unit, cadence, source_id, pillar, source_url, notes, staleness_budget_days)
      VALUES (@id, @name, @unit, @cadence, @source_id, @pillar, @source_url, @notes, @staleness_budget_days)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        unit = excluded.unit,
        cadence = excluded.cadence,
        source_id = excluded.source_id,
        pillar = excluded.pillar,
        source_url = excluded.source_url,
        notes = excluded.notes,
        staleness_budget_days = excluded.staleness_budget_days
    `);
    const run = this.db.transaction((rows: SeriesDef[]) => {
      for (const d of rows) {
        stmt.run({
          id: d.id,
          name: d.name,
          unit: d.unit,
          cadence: d.cadence,
          source_id: d.sourceId,
          pillar: d.pillar,
          source_url: d.sourceUrl ?? null,
          notes: d.notes ?? null,
          staleness_budget_days: d.stalenessBudgetDays,
        });
      }
    });
    run(defs);
  }

  async listSeries(filter: SeriesFilter = {}): Promise<SeriesDef[]> {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter.pillar) { clauses.push('pillar = @pillar'); params.pillar = filter.pillar; }
    if (filter.sourceId) { clauses.push('source_id = @sourceId'); params.sourceId = filter.sourceId; }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM series ${where} ORDER BY id`).all(params) as SeriesRow[];
    return rows.map(toSeriesDef);
  }

  async getSeries(id: string): Promise<SeriesDef | null> {
    const row = this.db.prepare('SELECT * FROM series WHERE id = ?').get(id) as SeriesRow | undefined;
    return row ? toSeriesDef(row) : null;
  }

  async putObservations(obs: Observation[]): Promise<number> {
    if (obs.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO observations (series_id, obs_date, value)
      VALUES (?, ?, ?)
      ON CONFLICT (series_id, obs_date) DO UPDATE SET value = excluded.value
    `);
    const run = this.db.transaction((rows: Observation[]) => {
      let n = 0;
      for (const o of rows) {
        // Guard here rather than in every connector: one NaN from a bad parse
        // otherwise poisons percentile ranks for a whole series.
        if (!Number.isFinite(o.value)) continue;
        stmt.run(o.seriesId, o.obsDate, o.value);
        n++;
      }
      return n;
    });
    return run(obs);
  }

  async getObservations(seriesId: string, from?: IsoDate, to?: IsoDate): Promise<Observation[]> {
    const clauses = ['series_id = @seriesId'];
    const params: Record<string, string> = { seriesId };
    if (from) { clauses.push('obs_date >= @from'); params.from = from; }
    if (to) { clauses.push('obs_date <= @to'); params.to = to; }
    const rows = this.db.prepare(
      `SELECT series_id, obs_date, value FROM observations
       WHERE ${clauses.join(' AND ')} ORDER BY obs_date`,
    ).all(params) as Array<{ series_id: string; obs_date: string; value: number }>;
    return rows.map((r) => ({ seriesId: r.series_id, obsDate: r.obs_date, value: r.value }));
  }

  async getLatestObservation(seriesId: string): Promise<Observation | null> {
    const row = this.db.prepare(
      `SELECT series_id, obs_date, value FROM observations
       WHERE series_id = ? ORDER BY obs_date DESC LIMIT 1`,
    ).get(seriesId) as { series_id: string; obs_date: string; value: number } | undefined;
    return row ? { seriesId: row.series_id, obsDate: row.obs_date, value: row.value } : null;
  }

  async getLatestObservations(seriesIds: string[]): Promise<Map<string, Observation>> {
    const out = new Map<string, Observation>();
    if (seriesIds.length === 0) return out;
    // Correlated subquery beats a window function here for D1/SQLite parity.
    const stmt = this.db.prepare(
      `SELECT series_id, obs_date, value FROM observations
       WHERE series_id = ? ORDER BY obs_date DESC LIMIT 1`,
    );
    for (const id of seriesIds) {
      const row = stmt.get(id) as { series_id: string; obs_date: string; value: number } | undefined;
      if (row) out.set(id, { seriesId: row.series_id, obsDate: row.obs_date, value: row.value });
    }
    return out;
  }

  async recordRun(run: SourceRun): Promise<void> {
    this.db.prepare(`
      INSERT INTO source_runs (source_id, started_at, finished_at, status, rows_written, events_written, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(run.sourceId, run.startedAt, run.finishedAt, run.status, run.rowsWritten, run.eventsWritten, run.error);
  }

  async getLatestRuns(): Promise<SourceRun[]> {
    const rows = this.db.prepare(`
      SELECT r.* FROM source_runs r
      JOIN (
        SELECT source_id, MAX(started_at) AS mx FROM source_runs GROUP BY source_id
      ) m ON m.source_id = r.source_id AND m.mx = r.started_at
      ORDER BY r.source_id
    `).all() as Array<{
      id: number; source_id: string; started_at: string; finished_at: string;
      status: string; rows_written: number; events_written: number; error: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status as SourceRun['status'],
      rowsWritten: r.rows_written,
      eventsWritten: r.events_written,
      error: r.error,
    }));
  }

  async markSeriesSuccess(seriesIds: string[], at: string): Promise<void> {
    if (seriesIds.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO series_health (series_id, last_obs_date, last_success_at)
      VALUES (
        @id,
        (SELECT MAX(obs_date) FROM observations WHERE series_id = @id),
        @at
      )
      ON CONFLICT (series_id) DO UPDATE SET
        last_obs_date = (SELECT MAX(obs_date) FROM observations WHERE series_id = @id),
        last_success_at = @at
    `);
    const run = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run({ id, at });
    });
    run(seriesIds);
  }

  async getSeriesHealth(): Promise<SeriesHealth[]> {
    const rows = this.db.prepare(`
      SELECT s.id AS series_id,
             s.staleness_budget_days,
             h.last_obs_date,
             h.last_success_at
      FROM series s
      LEFT JOIN series_health h ON h.series_id = s.id
      ORDER BY s.id
    `).all() as Array<{
      series_id: string; staleness_budget_days: number;
      last_obs_date: string | null; last_success_at: string | null;
    }>;
    const today = todayIso();
    return rows.map((r) => {
      const ageDays = r.last_obs_date ? daysBetween(r.last_obs_date, today) : null;
      return {
        seriesId: r.series_id,
        lastObsDate: r.last_obs_date,
        lastSuccessAt: r.last_success_at,
        stalenessBudgetDays: r.staleness_budget_days,
        ageDays,
        // No data at all counts as stale — a series that never loaded should
        // never be silently treated as fresh.
        stale: ageDays === null || ageDays > r.staleness_budget_days,
      };
    });
  }

  async putScores(scores: ScoreRecord[]): Promise<void> {
    if (scores.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO scores (score_date, key, kind, value, inputs)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (score_date, key) DO UPDATE SET
        kind = excluded.kind, value = excluded.value, inputs = excluded.inputs
    `);
    const run = this.db.transaction((rows: ScoreRecord[]) => {
      for (const s of rows) {
        stmt.run(s.scoreDate, s.key, s.kind, s.value, JSON.stringify(s.inputs ?? null));
      }
    });
    run(scores);
  }

  async getScores(scoreDate: IsoDate): Promise<ScoreRecord[]> {
    const rows = this.db.prepare(
      'SELECT score_date, key, kind, value, inputs FROM scores WHERE score_date = ?',
    ).all(scoreDate) as Array<{ score_date: string; key: string; kind: string; value: number; inputs: string }>;
    return rows.map((r) => ({
      scoreDate: r.score_date,
      key: r.key,
      kind: r.kind as ScoreKind,
      value: r.value,
      inputs: safeParse(r.inputs),
    }));
  }

  async getLatestScoreDate(): Promise<IsoDate | null> {
    const row = this.db.prepare('SELECT MAX(score_date) AS d FROM scores').get() as { d: string | null };
    return row?.d ?? null;
  }

  async getScoreHistory(key: string, from?: IsoDate): Promise<Array<{ scoreDate: IsoDate; value: number }>> {
    const rows = from
      ? this.db.prepare('SELECT score_date, value FROM scores WHERE key = ? AND score_date >= ? ORDER BY score_date').all(key, from)
      : this.db.prepare('SELECT score_date, value FROM scores WHERE key = ? ORDER BY score_date').all(key);
    return (rows as Array<{ score_date: string; value: number }>).map((r) => ({
      scoreDate: r.score_date, value: r.value,
    }));
  }

  async putEvents(events: WorldEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO events (id, ts, source_id, category, headline, url, severity, entities)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        severity = excluded.severity, headline = excluded.headline
    `);
    const run = this.db.transaction((rows: WorldEvent[]) => {
      for (const e of rows) {
        stmt.run(e.id, e.ts, e.sourceId, e.category, e.headline, e.url, e.severity,
          e.entities ? JSON.stringify(e.entities) : null);
      }
      return rows.length;
    });
    return run(events);
  }

  async listEvents(filter: EventFilter = {}): Promise<WorldEvent[]> {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.category) { clauses.push('category = @category'); params.category = filter.category; }
    if (filter.since) { clauses.push('ts >= @since'); params.since = filter.since; }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.limit = filter.limit ?? 200;
    const rows = this.db.prepare(
      `SELECT * FROM events ${where} ORDER BY ts DESC LIMIT @limit`,
    ).all(params) as Array<{
      id: string; ts: string; source_id: string; category: string;
      headline: string; url: string; severity: number; entities: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      sourceId: r.source_id,
      category: r.category,
      headline: r.headline,
      url: r.url,
      severity: r.severity,
      entities: r.entities ? (safeParse(r.entities) as string[]) : undefined,
    }));
  }

  async cacheGet(cacheKey: string): Promise<CachedResponse | null> {
    const row = this.db.prepare('SELECT * FROM raw_cache WHERE cache_key = ?').get(cacheKey) as
      { cache_key: string; source_id: string; url: string; fetched_at: string; body: string } | undefined;
    return row
      ? { cacheKey: row.cache_key, sourceId: row.source_id, url: row.url, fetchedAt: row.fetched_at, body: row.body }
      : null;
  }

  async cachePut(entry: CachedResponse): Promise<void> {
    this.db.prepare(`
      INSERT INTO raw_cache (cache_key, source_id, url, fetched_at, body)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (cache_key) DO UPDATE SET
        fetched_at = excluded.fetched_at, body = excluded.body
    `).run(entry.cacheKey, entry.sourceId, entry.url, entry.fetchedAt, entry.body);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
