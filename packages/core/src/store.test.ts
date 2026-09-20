import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MemoryStore } from './memory-store.js';
import { SqliteStore } from './sqlite-store.js';
import type { PipelineRun, SeriesDef, Store } from './index.js';

/**
 * Both `Store` implementations, tested against the same assertions.
 *
 * `MemoryStore` is what the pipeline tests run against, so it is only evidence
 * about production while it behaves like the SQLite one. Anywhere they diverge,
 * every test built on the fast one quietly stops meaning anything.
 */
const dirs: string[] = [];
function stores(): Array<{ name: string; make: () => Promise<Store> }> {
  return [
    { name: 'MemoryStore', make: async () => { const s = new MemoryStore(); await s.migrate(); return s; } },
    {
      name: 'SqliteStore',
      make: async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wd-store-'));
        dirs.push(dir);
        const s = new SqliteStore(join(dir, 'test.db'));
        await s.migrate();
        return s;
      },
    },
  ];
}

after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run one body against every implementation. */
function forEachStore(name: string, body: (store: Store) => Promise<void>): void {
  for (const s of stores()) {
    test(`${name} [${s.name}]`, async () => {
      const store = await s.make();
      try { await body(store); } finally { await store.close(); }
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

/* ----------------------------------------------------------------- migrate */

test('migrate is idempotent, so an existing database picks up a new table', async () => {
  // The path every upgrade takes: a database created before `pipeline_runs`
  // existed, opened by code that expects it.
  const dir = mkdtempSync(join(tmpdir(), 'wd-store-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');

  const first = new SqliteStore(path);
  await first.migrate();
  await first.recordPipelineRun(pipelineRun());
  await first.close();

  const second = new SqliteStore(path);
  await second.migrate();
  await second.migrate();
  assert.equal((await second.getPipelineRuns()).length, 1, 'migrating again must not wipe what is there');
  await second.close();
});
