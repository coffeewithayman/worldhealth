import pg from 'pg';
import {
  daysBetween, todayIso,
  type EventFilter, type SeriesFilter, type Store,
  type Cadence, type IsoDate, type Observation, type Pillar, type PipelineRun, type PipelineStage,
  type ScoreKind, type ScoreRecord, type SeriesDef, type SeriesHealth, type SourceRun, type WorldEvent,
} from '@wd/core';
import { MIGRATIONS, MIGRATIONS_TABLE_DDL, type MigrationContext } from './migrations.js';

/**
 * Postgres implementation of `Store` — what production runs on.
 *
 * Behaviour is pinned to `SqliteStore` by the shared contract tests in
 * `store.test.ts`; anything that differs between the two is a bug in whichever
 * one the tests say is wrong.
 */

/** Arbitrary constant: one migration runner per database at a time. */
const MIGRATION_LOCK_KEY = 7_140_214;

/**
 * Rows per bulk statement. Postgres caps a statement at 65,535 bind
 * parameters; the array-based upserts below bind one array per column, so this
 * bounds statement size and transaction length rather than parameter count.
 */
const CHUNK = 5_000;

export interface PostgresStoreOptions {
  connectionString: string;
  /**
   * Run inside this schema instead of `public`. Tests use it to give every
   * case its own empty database inside one server.
   */
  schema?: string;
  max?: number;
}

type Queryable = Pick<pg.PoolClient, 'query'>;

interface SeriesRow {
  id: string; name: string; unit: string; cadence: string; source_id: string;
  pillar: string | null; source_url: string | null; notes: string | null;
  staleness_budget_days: number; retired_at: string | null;
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
    retiredAt: r.retired_at ?? undefined,
  };
}

interface PipelineRunRow {
  id: number; stage: string; started_at: string; finished_at: string; status: string;
  ok_count: number; fail_count: number; rows_written: number;
  error: string | null; detail: string | null;
}

function toPipelineRun(r: PipelineRunRow): PipelineRun {
  return {
    id: r.id,
    stage: r.stage as PipelineStage,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as PipelineRun['status'],
    okCount: r.ok_count,
    failCount: r.fail_count,
    rowsWritten: r.rows_written,
    error: r.error,
    detail: r.detail ? safeParse(r.detail) : null,
  };
}

/**
 * Last write wins within one batch, keyed by `key`.
 *
 * SQLite applies a batch row by row, so a duplicate key simply overwrites.
 * Postgres rejects `ON CONFLICT DO UPDATE` touching the same row twice in one
 * statement ("cannot affect row a second time"). Collapsing first keeps the
 * SQLite semantics.
 */
function lastWins<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function quoteIdent(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`Unsafe SQL identifier: ${s}`);
  return `"${s}"`;
}

export class PostgresStore implements Store {
  private pool: pg.Pool;
  readonly schema: string | undefined;

  constructor(opts: PostgresStoreOptions) {
    this.schema = opts.schema;
    this.pool = new pg.Pool({ connectionString: opts.connectionString, max: opts.max ?? 5 });
    // An idle client dropped by the server must not crash the process.
    this.pool.on('error', () => { /* the next query reconnects */ });
    if (this.schema) {
      const set = `SET search_path TO ${quoteIdent(this.schema)}`;
      // Queued on the client ahead of any caller's query, so it always lands first.
      this.pool.on('connect', (client) => { void client.query(set).catch(() => {}); });
    }
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    await this.migrateReport();
  }

  /** `migrate()` that also says which migrations it applied. */
  async migrateReport(): Promise<number[]> {
    const client = await this.pool.connect();
    try {
      // The api pre-deploy step and a cron run can start together; the lock
      // makes the second wait and then find nothing left to do. Taken before
      // anything else: even CREATE SCHEMA IF NOT EXISTS races when concurrent.
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      try {
        if (this.schema) {
          await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.schema)}`);
          await client.query(`SET search_path TO ${quoteIdent(this.schema)}`);
        }
        await client.query(MIGRATIONS_TABLE_DDL);
        const { rows } = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
        const applied = new Set(rows.map((r) => Number(r.id)));
        const ctx: MigrationContext = {
          dialect: 'postgres',
          async exec(sql) { await client.query(sql); },
          async columnExists(table, column) {
            const r = await client.query(
              `SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
              [table, column],
            );
            return (r.rowCount ?? 0) > 0;
          },
        };
        const ran: number[] = [];
        for (const m of MIGRATIONS) {
          if (applied.has(m.id)) continue;
          await client.query('BEGIN');
          try {
            await m.up(ctx);
            await client.query(
              'INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)',
              [m.id, m.name, new Date().toISOString()],
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          }
          ran.push(m.id);
        }
        return ran;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
      }
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async upsertSeries(defs: SeriesDef[]): Promise<void> {
    if (defs.length === 0) return;
    const rows = lastWins(defs, (d) => d.id);
    await this.tx(async (c) => {
      for (const part of chunks(rows)) {
        await c.query(
          `INSERT INTO series (id, name, unit, cadence, source_id, pillar, source_url, notes, staleness_budget_days, retired_at)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                                $6::text[], $7::text[], $8::text[], $9::int[], $10::text[])
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             unit = excluded.unit,
             cadence = excluded.cadence,
             source_id = excluded.source_id,
             pillar = excluded.pillar,
             source_url = excluded.source_url,
             notes = excluded.notes,
             staleness_budget_days = excluded.staleness_budget_days,
             retired_at = excluded.retired_at`,
          [
            part.map((d) => d.id),
            part.map((d) => d.name),
            part.map((d) => d.unit),
            part.map((d) => d.cadence),
            part.map((d) => d.sourceId),
            part.map((d) => d.pillar),
            part.map((d) => d.sourceUrl ?? null),
            part.map((d) => d.notes ?? null),
            part.map((d) => d.stalenessBudgetDays),
            part.map((d) => d.retiredAt ?? null),
          ],
        );
      }
    });
  }

  async listSeries(filter: SeriesFilter = {}): Promise<SeriesDef[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.pillar) { params.push(filter.pillar); clauses.push(`pillar = $${params.length}`); }
    if (filter.sourceId) { params.push(filter.sourceId); clauses.push(`source_id = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.pool.query<SeriesRow>(`SELECT * FROM series ${where} ORDER BY id`, params);
    return rows.map(toSeriesDef);
  }

  async getSeries(id: string): Promise<SeriesDef | null> {
    const { rows } = await this.pool.query<SeriesRow>('SELECT * FROM series WHERE id = $1', [id]);
    return rows[0] ? toSeriesDef(rows[0]) : null;
  }

  async putObservations(obs: Observation[]): Promise<number> {
    // Guard here rather than in every connector: one NaN from a bad parse
    // otherwise poisons percentile ranks for a whole series.
    const finite = obs.filter((o) => Number.isFinite(o.value));
    if (finite.length === 0) return 0;
    const rows = lastWins(finite, (o) => `${o.seriesId}\u0000${o.obsDate}`);
    await this.tx(async (c) => {
      for (const part of chunks(rows)) {
        await c.query(
          `INSERT INTO observations (series_id, obs_date, value)
           SELECT * FROM unnest($1::text[], $2::text[], $3::float8[])
           ON CONFLICT (series_id, obs_date) DO UPDATE SET value = excluded.value`,
          [part.map((o) => o.seriesId), part.map((o) => o.obsDate), part.map((o) => o.value)],
        );
      }
    });
    // Same count SqliteStore reports: every finite row offered, duplicates included.
    return finite.length;
  }

  async getObservations(seriesId: string, from?: IsoDate, to?: IsoDate): Promise<Observation[]> {
    const clauses = ['series_id = $1'];
    const params: string[] = [seriesId];
    if (from) { params.push(from); clauses.push(`obs_date >= $${params.length}`); }
    if (to) { params.push(to); clauses.push(`obs_date <= $${params.length}`); }
    const { rows } = await this.pool.query<{ series_id: string; obs_date: string; value: number }>(
      `SELECT series_id, obs_date, value FROM observations
       WHERE ${clauses.join(' AND ')} ORDER BY obs_date`,
      params,
    );
    return rows.map((r) => ({ seriesId: r.series_id, obsDate: r.obs_date, value: r.value }));
  }

  async getLatestObservation(seriesId: string): Promise<Observation | null> {
    const { rows } = await this.pool.query<{ series_id: string; obs_date: string; value: number }>(
      `SELECT series_id, obs_date, value FROM observations
       WHERE series_id = $1 ORDER BY obs_date DESC LIMIT 1`,
      [seriesId],
    );
    const r = rows[0];
    return r ? { seriesId: r.series_id, obsDate: r.obs_date, value: r.value } : null;
  }

  async getLatestObservations(seriesIds: string[]): Promise<Map<string, Observation>> {
    const out = new Map<string, Observation>();
    if (seriesIds.length === 0) return out;
    const { rows } = await this.pool.query<{ series_id: string; obs_date: string; value: number }>(
      `SELECT DISTINCT ON (series_id) series_id, obs_date, value FROM observations
       WHERE series_id = ANY($1::text[]) ORDER BY series_id, obs_date DESC`,
      [seriesIds],
    );
    for (const r of rows) out.set(r.series_id, { seriesId: r.series_id, obsDate: r.obs_date, value: r.value });
    return out;
  }

  async recordRun(run: SourceRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO source_runs (source_id, started_at, finished_at, status, rows_written, events_written, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [run.sourceId, run.startedAt, run.finishedAt, run.status, run.rowsWritten, run.eventsWritten, run.error],
    );
  }

  async getLatestRuns(): Promise<SourceRun[]> {
    const { rows } = await this.pool.query<{
      id: number; source_id: string; started_at: string; finished_at: string;
      status: string; rows_written: number; events_written: number; error: string | null;
    }>(`
      SELECT r.* FROM source_runs r
      JOIN (
        SELECT source_id, MAX(started_at) AS mx FROM source_runs GROUP BY source_id
      ) m ON m.source_id = r.source_id AND m.mx = r.started_at
      ORDER BY r.source_id
    `);
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

  async recordPipelineRun(run: PipelineRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO pipeline_runs (stage, started_at, finished_at, status, ok_count, fail_count, rows_written, error, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        run.stage, run.startedAt, run.finishedAt, run.status,
        run.okCount, run.failCount, run.rowsWritten, run.error,
        run.detail === undefined ? null : JSON.stringify(run.detail),
      ],
    );
  }

  async getLatestPipelineRuns(): Promise<PipelineRun[]> {
    const { rows } = await this.pool.query<PipelineRunRow>(`
      SELECT p.* FROM pipeline_runs p
      JOIN (
        SELECT stage, MAX(started_at) AS mx FROM pipeline_runs GROUP BY stage
      ) m ON m.stage = p.stage AND m.mx = p.started_at
      ORDER BY p.started_at DESC, p.id DESC
    `);
    return rows.map(toPipelineRun);
  }

  async getPipelineRuns(stage?: PipelineStage, limit = 50): Promise<PipelineRun[]> {
    const { rows } = stage
      ? await this.pool.query<PipelineRunRow>(
        'SELECT * FROM pipeline_runs WHERE stage = $1 ORDER BY started_at DESC, id DESC LIMIT $2', [stage, limit])
      : await this.pool.query<PipelineRunRow>(
        'SELECT * FROM pipeline_runs ORDER BY started_at DESC, id DESC LIMIT $1', [limit]);
    return rows.map(toPipelineRun);
  }

  async markSeriesSuccess(seriesIds: string[], at: string): Promise<void> {
    if (seriesIds.length === 0) return;
    const ids = [...new Set(seriesIds)];
    await this.tx(async (c) => {
      for (const part of chunks(ids)) {
        await c.query(
          `INSERT INTO series_health (series_id, last_obs_date, last_success_at)
           SELECT ids.id, (SELECT MAX(obs_date) FROM observations o WHERE o.series_id = ids.id), $2
           FROM unnest($1::text[]) AS ids(id)
           ON CONFLICT (series_id) DO UPDATE SET
             last_obs_date = excluded.last_obs_date,
             last_success_at = excluded.last_success_at`,
          [part, at],
        );
      }
    });
  }

  async getSeriesHealth(): Promise<SeriesHealth[]> {
    const { rows } = await this.pool.query<{
      series_id: string; staleness_budget_days: number; retired_at: string | null;
      last_obs_date: string | null; last_success_at: string | null;
    }>(`
      SELECT s.id AS series_id,
             s.staleness_budget_days,
             s.retired_at,
             h.last_obs_date,
             h.last_success_at
      FROM series s
      LEFT JOIN series_health h ON h.series_id = s.id
      ORDER BY s.id
    `);
    const today = todayIso();
    return rows.map((r) => {
      const ageDays = r.last_obs_date ? daysBetween(r.last_obs_date, today) : null;
      const retired = r.retired_at !== null;
      return {
        seriesId: r.series_id,
        lastObsDate: r.last_obs_date,
        lastSuccessAt: r.last_success_at,
        stalenessBudgetDays: r.staleness_budget_days,
        ageDays,
        // Same rules as SqliteStore: never-loaded is stale, retired never is.
        stale: !retired && (ageDays === null || ageDays > r.staleness_budget_days),
        retired,
        retiredAt: r.retired_at,
      };
    });
  }

  async putScores(scores: ScoreRecord[]): Promise<void> {
    if (scores.length === 0) return;
    const rows = lastWins(scores, (s) => `${s.scoreDate}\u0000${s.key}`);
    await this.tx(async (c) => {
      for (const part of chunks(rows)) {
        await c.query(
          `INSERT INTO scores (score_date, key, kind, value, inputs)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::text[])
           ON CONFLICT (score_date, key) DO UPDATE SET
             kind = excluded.kind, value = excluded.value, inputs = excluded.inputs`,
          [
            part.map((s) => s.scoreDate),
            part.map((s) => s.key),
            part.map((s) => s.kind),
            part.map((s) => s.value),
            part.map((s) => JSON.stringify(s.inputs ?? null)),
          ],
        );
      }
    });
  }

  async getScores(scoreDate: IsoDate): Promise<ScoreRecord[]> {
    const { rows } = await this.pool.query<{
      score_date: string; key: string; kind: string; value: number; inputs: string;
    }>('SELECT score_date, key, kind, value, inputs FROM scores WHERE score_date = $1', [scoreDate]);
    return rows.map((r) => ({
      scoreDate: r.score_date,
      key: r.key,
      kind: r.kind as ScoreKind,
      value: r.value,
      inputs: safeParse(r.inputs),
    }));
  }

  async getLatestScoreDate(): Promise<IsoDate | null> {
    const { rows } = await this.pool.query<{ d: string | null }>('SELECT MAX(score_date) AS d FROM scores');
    return rows[0]?.d ?? null;
  }

  async getScoreHistory(key: string, from?: IsoDate): Promise<Array<{ scoreDate: IsoDate; value: number }>> {
    const { rows } = from
      ? await this.pool.query<{ score_date: string; value: number }>(
        'SELECT score_date, value FROM scores WHERE key = $1 AND score_date >= $2 ORDER BY score_date', [key, from])
      : await this.pool.query<{ score_date: string; value: number }>(
        'SELECT score_date, value FROM scores WHERE key = $1 ORDER BY score_date', [key]);
    return rows.map((r) => ({ scoreDate: r.score_date, value: r.value }));
  }

  async putEvents(events: WorldEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const rows = lastWins(events, (e) => e.id);
    await this.tx(async (c) => {
      for (const part of chunks(rows)) {
        await c.query(
          `INSERT INTO events (id, ts, source_id, category, headline, url, severity, entities)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                                $6::text[], $7::float8[], $8::text[])
           ON CONFLICT (id) DO UPDATE SET
             severity = excluded.severity, headline = excluded.headline`,
          [
            part.map((e) => e.id),
            part.map((e) => e.ts),
            part.map((e) => e.sourceId),
            part.map((e) => e.category),
            part.map((e) => e.headline),
            part.map((e) => e.url),
            part.map((e) => e.severity),
            part.map((e) => (e.entities ? JSON.stringify(e.entities) : null)),
          ],
        );
      }
    });
    return events.length;
  }

  async listEvents(filter: EventFilter = {}): Promise<WorldEvent[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.category) { params.push(filter.category); clauses.push(`category = $${params.length}`); }
    if (filter.since) { params.push(filter.since); clauses.push(`ts >= $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(filter.limit ?? 200);
    const { rows } = await this.pool.query<{
      id: string; ts: string; source_id: string; category: string;
      headline: string; url: string; severity: number; entities: string | null;
    }>(`SELECT * FROM events ${where} ORDER BY ts DESC, id LIMIT $${params.length}`, params);
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

  /* ------------------------------------------------ copy-store (write half) */

  /**
   * Insert raw rows keyed by column name, leaving any existing row alone.
   *
   * `DO NOTHING` makes a re-run of `copy-store` safe after production has
   * started writing: nothing the live pipeline wrote is overwritten by the
   * older local copy.
   */
  async insertRaw(table: string, rows: Array<Record<string, unknown>>, db: Queryable = this.pool): Promise<void> {
    if (rows.length === 0) return;
    const cols = Object.keys(rows[0]!);
    // Stay well under the 65,535 bind-parameter ceiling however wide the table.
    const per = Math.max(1, Math.floor(60_000 / cols.length));
    for (const part of chunks(rows, per)) {
      const params: unknown[] = [];
      const tuples = part.map((r) => {
        const slots = cols.map((c) => { params.push(r[c] ?? null); return `$${params.length}`; });
        return `(${slots.join(', ')})`;
      });
      await db.query(
        `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')})
         VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
        params,
      );
    }
  }

  /** After inserting explicit ids, move the identity past them. */
  async resetIdentity(table: string): Promise<void> {
    await this.pool.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 0) + 1, false)`,
      [table],
    );
  }

  /** Test helper: remove the private schema this store was created with. */
  async dropSchema(): Promise<void> {
    if (!this.schema) throw new Error('dropSchema() needs a store created with a schema');
    await this.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(this.schema)} CASCADE`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
