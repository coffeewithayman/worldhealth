import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MemoryStore, type PipelineRun, type SeriesDef, type Store } from '@wd/core';
import { SqliteStore } from './sqlite-store.js';
import { PostgresStore } from './postgres-store.js';
import { MIGRATIONS } from './migrations.js';
import { copyStore } from './copy.js';
import { resolveStoreTarget } from './index.js';

/**
 * Every `Store` implementation, tested against the same assertions.
 *
 * `MemoryStore` is what the pipeline tests run against, so it is only evidence
 * about production while it behaves like the real ones. `PostgresStore` is
 * production. Anywhere they diverge, every test built on the fast one quietly
 * stops meaning anything.
 *
 * Postgres cases run when `WD_TEST_DATABASE_URL` points at a server (CI sets
 * it; locally: `docker compose up -d postgres`). Each case gets its own schema.
 */
const PG_URL = process.env.WD_TEST_DATABASE_URL;
const dirs: string[] = [];
const pgStores: PostgresStore[] = [];

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wd-store-'));
  dirs.push(dir);
  return join(dir, 'test.db');
}

let schemaSeq = 0;
function pgStore(): PostgresStore {
  const schema = `wd_test_${process.pid}_${Date.now().toString(36)}_${schemaSeq++}`;
  const s = new PostgresStore({ connectionString: PG_URL!, schema, max: 2 });
  pgStores.push(s);
  return s;
}

function stores(): Array<{ name: string; make: () => Promise<Store> }> {
  const out: Array<{ name: string; make: () => Promise<Store> }> = [
    { name: 'MemoryStore', make: async () => { const s = new MemoryStore(); await s.migrate(); return s; } },
    { name: 'SqliteStore', make: async () => { const s = new SqliteStore(tmpDb()); await s.migrate(); return s; } },
  ];
  if (PG_URL) out.push({ name: 'PostgresStore', make: async () => { const s = pgStore(); await s.migrate(); return s; } });
  return out;
}

after(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  // Schemas are dropped through a fresh pool: each test closed its own.
  if (PG_URL && pgStores.length) {
    for (const s of pgStores) {
      const cleaner = new PostgresStore({ connectionString: PG_URL, schema: s.schema, max: 1 });
      await cleaner.dropSchema().catch(() => {});
      await cleaner.close();
    }
  }
});

/** Run one body against every implementation. */
function forEachStore(name: string, body: (store: Store) => Promise<void>): void {
  for (const s of stores()) {
    test(`${name} [${s.name}]`, async () => {
      const store = await s.make();
      try { await body(store); } finally { await store.close(); }
    });
  }
}

/** SQLite and Postgres only — the migration machinery MemoryStore does not have. */
function forEachSqlStore(
  name: string,
  body: (make: () => SqliteStore | PostgresStore) => Promise<void>,
): void {
  test(`${name} [SqliteStore]`, async () => { const p = tmpDb(); await body(() => new SqliteStore(p)); });
  if (PG_URL) {
    test(`${name} [PostgresStore]`, async () => {
      const first = pgStore();
      const schema = first.schema;
      await first.close();
      await body(() => new PostgresStore({ connectionString: PG_URL, schema, max: 2 }));
    });
  }
}

function series(id: string, over: Partial<SeriesDef> = {}): SeriesDef {
  return {
    id, name: id, unit: 'index', cadence: 'daily', sourceId: 'test',
    pillar: 'monetary', stalenessBudgetDays: 7, ...over,
  };
}

function pipelineRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    stage: 'ingest',
    startedAt: '2026-09-19T06:00:00.000Z',
    finishedAt: '2026-09-19T06:02:00.000Z',
    status: 'ok',
    okCount: 9,
    failCount: 0,
    rowsWritten: 1200,
    error: null,
    detail: null,
    ...over,
  };
}

/* ----------------------------------------------------------- pipeline runs */

forEachStore('a pipeline run round-trips with its detail intact', async (store) => {
  await store.recordPipelineRun(pipelineRun({
    status: 'partial',
    failCount: 2,
    error: '2 unit(s) failed: bis, gdelt',
    detail: { failed: [{ id: 'bis', error: 'HTTP 500' }, { id: 'gdelt' }], skipped: ['eia'] },
  }));

  const [run] = await store.getLatestPipelineRuns();
  assert.ok(run);
  assert.equal(run!.stage, 'ingest');
  assert.equal(run!.status, 'partial');
  assert.equal(run!.failCount, 2);
  assert.equal(run!.rowsWritten, 1200);
  // The alert engine reads `detail.failed` — if it does not survive the column
  // it is stored in, a failed derivation stops being visible on the dashboard.
  const detail = run!.detail as { failed: Array<{ id: string }>; skipped: string[] };
  assert.deepEqual(detail.failed.map((f) => f.id), ['bis', 'gdelt']);
  assert.deepEqual(detail.skipped, ['eia']);
});

forEachStore('getLatestPipelineRuns returns the newest run of each stage', async (store) => {
  await store.recordPipelineRun(pipelineRun({ stage: 'ingest', startedAt: '2026-09-17T06:00:00.000Z' }));
  await store.recordPipelineRun(pipelineRun({ stage: 'ingest', startedAt: '2026-09-19T06:00:00.000Z', rowsWritten: 99 }));
  await store.recordPipelineRun(pipelineRun({ stage: 'derive', startedAt: '2026-09-18T06:00:00.000Z' }));

  const latest = await store.getLatestPipelineRuns();
  assert.equal(latest.length, 2, 'one row per stage');
  const ingest = latest.find((r) => r.stage === 'ingest')!;
  assert.equal(ingest.rowsWritten, 99, 'the newest ingest, not the first');
  assert.equal(latest[0]!.startedAt, '2026-09-19T06:00:00.000Z', 'newest first');
});

forEachStore('pipeline history can be filtered by stage and limited', async (store) => {
  for (let i = 1; i <= 5; i++) {
    await store.recordPipelineRun(pipelineRun({ stage: 'daily', startedAt: `2026-09-0${i}T06:00:00.000Z` }));
  }
  await store.recordPipelineRun(pipelineRun({ stage: 'score' }));

  assert.equal((await store.getPipelineRuns('daily')).length, 5);
  assert.equal((await store.getPipelineRuns('daily', 2)).length, 2);
  assert.equal((await store.getPipelineRuns()).length, 6);
  assert.equal((await store.getPipelineRuns('daily', 2))[0]!.startedAt, '2026-09-05T06:00:00.000Z');
});

forEachStore('runs that start in the same millisecond come back newest-recorded first', async (store) => {
  // `daily` wraps `ingest` and they share a start time. Found by diffing the
  // SQLite- and Postgres-backed APIs over real data: without a tiebreak the
  // two engines listed them in opposite orders.
  const t = '2026-09-20T22:28:15.000Z';
  await store.recordPipelineRun(pipelineRun({ stage: 'ingest', startedAt: t }));
  await store.recordPipelineRun(pipelineRun({ stage: 'daily', startedAt: t }));
  assert.deepEqual((await store.getPipelineRuns()).map((r) => r.stage), ['daily', 'ingest']);
  assert.deepEqual((await store.getLatestPipelineRuns()).map((r) => r.stage), ['daily', 'ingest']);
});

forEachStore('runs accumulate rather than overwrite, so a failure leaves a trail', async (store) => {
  await store.recordPipelineRun(pipelineRun({ status: 'error', error: 'boom' }));
  await store.recordPipelineRun(pipelineRun({ startedAt: '2026-09-19T07:00:00.000Z' }));
  const all = await store.getPipelineRuns('ingest');
  assert.equal(all.length, 2);
  assert.equal(all[1]!.error, 'boom', 'yesterday\'s failure is still on the record');
});

/* ------------------------------------------------------------ observations */

forEachStore('re-ingesting a window overwrites rather than duplicating', async (store) => {
  await store.upsertSeries([series('x.a')]);
  await store.putObservations([{ seriesId: 'x.a', obsDate: '2026-09-01', value: 1 }]);
  await store.putObservations([{ seriesId: 'x.a', obsDate: '2026-09-01', value: 2 }]);
  const obs = await store.getObservations('x.a');
  assert.deepEqual(obs, [{ seriesId: 'x.a', obsDate: '2026-09-01', value: 2 }]);
});

forEachStore('a non-finite value is rejected at the door', async (store) => {
  // One NaN poisons every percentile rank computed from the series afterwards,
  // and does it without an error anywhere.
  await store.upsertSeries([series('x.a')]);
  const written = await store.putObservations([
    { seriesId: 'x.a', obsDate: '2026-09-01', value: NaN },
    { seriesId: 'x.a', obsDate: '2026-09-02', value: 5 },
  ]);
  assert.equal(written, 1);
  assert.deepEqual((await store.getObservations('x.a')).map((o) => o.value), [5]);
});

forEachStore('observations come back in date order whatever order they arrived', async (store) => {
  await store.upsertSeries([series('x.a')]);
  await store.putObservations([
    { seriesId: 'x.a', obsDate: '2026-09-03', value: 3 },
    { seriesId: 'x.a', obsDate: '2026-09-01', value: 1 },
    { seriesId: 'x.a', obsDate: '2026-09-02', value: 2 },
  ]);
  assert.deepEqual((await store.getObservations('x.a')).map((o) => o.obsDate),
    ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal((await store.getLatestObservation('x.a'))?.value, 3);
});

/* ------------------------------------------------------------------ health */

forEachStore('a series with no observations at all counts as stale', async (store) => {
  await store.upsertSeries([series('x.never')]);
  const [h] = await store.getSeriesHealth();
  assert.equal(h!.stale, true, 'never loaded must never read as fresh');
  assert.equal(h!.ageDays, null);
  assert.equal(h!.lastObsDate, null);
});

forEachStore('a retired series reports its end date and is never stale', async (store) => {
  // FRED discontinued us.nonperforming_loans after 2020-07-01. Its history is
  // still worth keeping and still scores in an --as-of backtest inside that
  // window, but it must stop raising an alert nothing can act on.
  await store.upsertSeries([series('x.retired', { retiredAt: '2020-07-01', stalenessBudgetDays: 230 })]);
  await store.putObservations([{ seriesId: 'x.retired', obsDate: '2020-07-01', value: 1.06 }]);
  // SqliteStore derives last_obs_date in markSeriesSuccess, which is the step
  // the real pipeline runs after a connector writes; MemoryStore reads the
  // observations directly. Calling it keeps the two comparable.
  await store.markSeriesSuccess(['x.retired'], '2026-09-20T00:00:00.000Z');

  const [h] = await store.getSeriesHealth();
  assert.equal(h!.retired, true);
  assert.equal(h!.retiredAt, '2020-07-01');
  assert.equal(h!.stale, false, 'a series that has ended is complete, not broken');
  assert.ok((h!.ageDays ?? 0) > 230, 'its age is still reported — it is a fact, not a fault');

  assert.equal((await store.getSeries('x.retired'))?.retiredAt, '2020-07-01');
});

forEachStore('retirement can be lifted by an upsert, like any other field', async (store) => {
  // A series wrongly marked dead must come back on the next ingest rather than
  // needing someone to go and edit the database by hand.
  await store.upsertSeries([series('x.back', { retiredAt: '2020-07-01' })]);
  await store.upsertSeries([series('x.back')]);
  const [h] = await store.getSeriesHealth();
  assert.equal(h!.retired, false);
  assert.equal(h!.retiredAt, null);
});

/* ------------------------------------------------------ batches and bulk */

forEachStore('a duplicate key inside one batch resolves to the last row', async (store) => {
  // SQLite applies a batch row by row; Postgres refuses to upsert one row twice
  // in a single statement. A connector that emits a revised point twice must
  // get the same answer from both.
  await store.upsertSeries([series('x.a'), series('x.a', { name: 'renamed' })]);
  const n = await store.putObservations([
    { seriesId: 'x.a', obsDate: '2026-09-01', value: 1 },
    { seriesId: 'x.a', obsDate: '2026-09-01', value: 2 },
  ]);
  assert.equal(n, 2, 'the count is rows offered, as it always was');
  assert.deepEqual((await store.getObservations('x.a')).map((o) => o.value), [2]);
  assert.equal((await store.getSeries('x.a'))?.name, 'renamed');
});

forEachStore('getLatestObservations answers for many series in one call', async (store) => {
  await store.upsertSeries([series('x.a'), series('x.b'), series('x.empty')]);
  await store.putObservations([
    { seriesId: 'x.a', obsDate: '2026-09-01', value: 1 },
    { seriesId: 'x.a', obsDate: '2026-09-03', value: 3 },
    { seriesId: 'x.b', obsDate: '2026-08-01', value: 9 },
  ]);
  const latest = await store.getLatestObservations(['x.a', 'x.b', 'x.empty']);
  assert.equal(latest.get('x.a')?.value, 3);
  assert.equal(latest.get('x.b')?.obsDate, '2026-08-01');
  assert.equal(latest.has('x.empty'), false);
});

forEachStore('a batch larger than one statement chunk lands whole', async (store) => {
  await store.upsertSeries([series('x.big')]);
  const obs = Array.from({ length: 12_345 }, (_, i) => ({
    seriesId: 'x.big', obsDate: `1990-01-01#${String(i).padStart(5, '0')}`, value: i + 0.125,
  }));
  assert.equal(await store.putObservations(obs), obs.length);
  const back = await store.getObservations('x.big');
  assert.equal(back.length, obs.length);
  // 8-byte floats: a 4-byte REAL on Postgres would round this.
  await store.putObservations([{ seriesId: 'x.big', obsDate: '2000-01-01', value: 4.123456789012 }]);
  assert.equal((await store.getObservations('x.big', '2000-01-01', '2000-01-01'))[0]?.value, 4.123456789012);
});

forEachStore('ids sort in byte order, whatever locale the database was created with', async (store) => {
  // A glibc/ICU collation ignores punctuation and would put us_a first. Only
  // shows up against a Debian-based Postgres (CI uses one); Alpine's musl
  // sorts bytewise by accident.
  await store.upsertSeries(['usb', 'us_a', 'us.ab', 'us.a_b'].map((id) => series(id)));
  assert.deepEqual((await store.listSeries()).map((s) => s.id), ['us.a_b', 'us.ab', 'us_a', 'usb']);
});

forEachStore('ping succeeds on an open store', async (store) => {
  await store.ping();
});

/* ----------------------------------------------------------------- migrate */

forEachSqlStore('migrate records every migration once, and a re-run applies nothing', async (make) => {
  const first = make();
  assert.deepEqual(await first.migrateReport(), MIGRATIONS.map((m) => m.id));
  await first.recordPipelineRun(pipelineRun());
  await first.close();

  const second = make();
  assert.deepEqual(await second.migrateReport(), [], 'nothing left to apply');
  assert.equal((await second.getPipelineRuns()).length, 1, 'migrating again must not wipe what is there');
  await second.close();
});

if (PG_URL) {
  test('concurrent migrations on one Postgres database serialise on the lock', async () => {
    // Railway runs the api pre-deploy migrate while a cron run may be starting.
    const a = pgStore();
    const b = new PostgresStore({ connectionString: PG_URL, schema: a.schema, max: 2 });
    try {
      const [ra, rb] = await Promise.all([a.migrateReport(), b.migrateReport()]);
      assert.deepEqual([...ra, ...rb].sort((x, y) => x - y), MIGRATIONS.map((m) => m.id),
        'each migration applied by exactly one of the two');
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('copyStore carries a SQLite database into Postgres and is safe to re-run', async () => {
    const src = new SqliteStore(tmpDb());
    await src.migrate();
    await src.upsertSeries([series('x.a', { retiredAt: '2020-07-01' })]);
    await src.putObservations([
      { seriesId: 'x.a', obsDate: '2020-06-01', value: 1.5 },
      { seriesId: 'x.a', obsDate: '2020-07-01', value: 2.5 },
    ]);
    await src.markSeriesSuccess(['x.a'], '2026-09-20T00:00:00.000Z');
    await src.recordPipelineRun(pipelineRun());
    await src.recordRun({
      sourceId: 'fred', startedAt: '2026-09-19T06:00:00.000Z', finishedAt: '2026-09-19T06:01:00.000Z',
      status: 'ok', rowsWritten: 2, eventsWritten: 0, error: null,
    });
    await src.putScores([{ scoreDate: '2026-09-19', key: 'composite', kind: 'composite', value: 41.2, inputs: { a: 1 } }]);

    const dst = pgStore();
    await dst.migrate();
    try {
      await copyStore(src, dst);
      // Production writes first, then someone re-runs the copy by mistake.
      await dst.putObservations([{ seriesId: 'x.a', obsDate: '2020-07-01', value: 99 }]);
      await copyStore(src, dst);

      assert.deepEqual((await dst.getObservations('x.a')).map((o) => o.value), [1.5, 99],
        'a re-run never overwrites what production wrote');
      assert.equal((await dst.getSeries('x.a'))?.retiredAt, '2020-07-01');
      assert.equal((await dst.getSeriesHealth())[0]?.lastObsDate, '2020-07-01');
      assert.equal((await dst.getScores('2026-09-19'))[0]?.value, 41.2);
      assert.equal((await dst.getLatestRuns())[0]?.sourceId, 'fred');
      // Identity advanced past the copied ids, so the next insert does not collide.
      await dst.recordPipelineRun(pipelineRun({ startedAt: '2026-09-20T06:00:00.000Z' }));
      assert.equal((await dst.getPipelineRuns()).length, 2);
    } finally {
      await src.close();
      await dst.close();
    }
  });
}

/* ------------------------------------------------------------------ factory */

test('DATABASE_URL selects Postgres, and without it the local SQLite file is used', () => {
  assert.deepEqual(resolveStoreTarget({ DATABASE_URL: 'postgres://u:p@h:5432/db' }),
    { kind: 'postgres', connectionString: 'postgres://u:p@h:5432/db' });
  assert.equal(resolveStoreTarget({ DATABASE_URL: 'postgresql://h/db' }).kind, 'postgres');
  assert.deepEqual(resolveStoreTarget({ WD_DB_PATH: '/tmp/x.db' }), { kind: 'sqlite', path: '/tmp/x.db' });
  assert.deepEqual(resolveStoreTarget({ DATABASE_URL: 'sqlite:/tmp/y.db' }), { kind: 'sqlite', path: '/tmp/y.db' });
  assert.match((resolveStoreTarget({}) as { path: string }).path, /data\/world\.db$/);
  assert.throws(() => resolveStoreTarget({ DATABASE_URL: 'mysql://h/db' }), /postgres/);
});

test('a database created before versioning adopts the migrations without losing a row', async () => {
  // The local world.db predates schema_migrations and, depending on which
  // checkout created it, may lack series.retired_at. Baseline is all IF NOT
  // EXISTS and 0002 adds the column only when missing, so both shapes upgrade.
  const path = tmpDb();
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE series (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, cadence TEXT NOT NULL,
    source_id TEXT NOT NULL, pillar TEXT, source_url TEXT, notes TEXT,
    staleness_budget_days INTEGER NOT NULL DEFAULT 7
  )`);
  legacy.prepare(
    `INSERT INTO series (id, name, unit, cadence, source_id, staleness_budget_days)
     VALUES ('x.old', 'Old', 'index', 'daily', 'fred', 7)`,
  ).run();
  legacy.close();

  const store = new SqliteStore(path);
  await store.migrate();
  await store.upsertSeries([series('x.new', { retiredAt: '2020-07-01' })]);

  const ids = (await store.listSeries()).map((s) => s.id);
  assert.deepEqual(ids, ['x.new', 'x.old'], 'the pre-existing row survives the upgrade');
  assert.equal((await store.getSeries('x.new'))?.retiredAt, '2020-07-01');
  assert.equal((await store.getSeries('x.old'))?.retiredAt, undefined);
  await store.close();
});
