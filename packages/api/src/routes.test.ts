import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { MemoryStore, type PipelineRun, type SeriesDef, type SourceRun } from '@wd/core';
import { createRoutes } from './routes.js';

const CONFIG = resolve(import.meta.dirname, '../../..', 'config/indicators.yaml');

function app(store: MemoryStore) {
  const routes = createRoutes({ store, configPath: CONFIG });
  return async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await routes.request(`http://localhost${path}`);
    return { status: res.status, body: await res.json() as T };
  };
}

function seriesDef(id: string, sourceId: string): SeriesDef {
  return {
    id, name: id, unit: 'index', cadence: 'daily', sourceId,
    pillar: 'monetary', stalenessBudgetDays: 7,
  };
}

function pipelineRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    stage: 'daily',
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    finishedAt: new Date(Date.now() - 3_500_000).toISOString(),
    status: 'ok', okCount: 10, failCount: 0, rowsWritten: 100, error: null, detail: null,
    ...over,
  };
}

function sourceRun(sourceId: string, over: Partial<SourceRun> = {}): SourceRun {
  return {
    sourceId,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    finishedAt: new Date(Date.now() - 3_500_000).toISOString(),
    status: 'ok', rowsWritten: 10, eventsWritten: 0, error: null,
    ...over,
  };
}

interface DashboardBody {
  asOf: string;
  alerts: Array<{ kind: string; severity: string; action: string | null }>;
  alertSummary: { total: number; critical: number; worst: string | null };
  health: { lastUpdate: PipelineRun | null; pipeline: PipelineRun[] };
}

/* --------------------------------------------------------------- dashboard */

test('the dashboard payload carries its own alerts', async () => {
  // One request, not two: there must be no window in which the page has a
  // composite score on screen and nothing saying the pipeline feeding it died.
  const store = new MemoryStore();
  const get = app(store);
  const { status, body } = await get<DashboardBody>('/api/dashboard');

  assert.equal(status, 200);
  assert.ok(Array.isArray(body.alerts));
  assert.equal(body.alertSummary.worst, 'critical', 'an empty database has never run');
  assert.ok(body.alerts.some((a) => a.kind === 'pipeline_never_ran'));
});

test('a recent run clears the never-ran alert and fills lastUpdate', async () => {
  const store = new MemoryStore();
  await store.recordPipelineRun(pipelineRun());
  const { body } = await app(store)<DashboardBody>('/api/dashboard');

  assert.equal(body.alerts.some((a) => a.kind === 'pipeline_never_ran'), false);
  assert.ok(body.health.lastUpdate, 'the page needs to be able to print when data last arrived');
  assert.equal(body.health.lastUpdate!.stage, 'daily');
});

test('a scoring-only run does not count as an update', async () => {
  const store = new MemoryStore();
  await store.recordPipelineRun(pipelineRun({ stage: 'score' }));
  const { body } = await app(store)<DashboardBody>('/api/dashboard');
  assert.equal(body.health.lastUpdate, null);
  assert.ok(body.alerts.some((a) => a.kind === 'pipeline_never_ran'));
});

/* ------------------------------------------------------------------ alerts */

test('/api/alerts serves the same list with a summary', async () => {
  const store = new MemoryStore();
  await store.recordPipelineRun(pipelineRun({ stage: 'derive', status: 'error', error: 'boom' }));
  await store.recordPipelineRun(pipelineRun());

  const { body } = await app(store)<{ alerts: Array<{ kind: string }>; summary: { critical: number } }>('/api/alerts');
  assert.ok(body.alerts.some((a) => a.kind === 'pipeline_failed'));
  assert.ok(body.summary.critical >= 1);
});

test('the sources payload carries alerts and the pipeline history', async () => {
  const store = new MemoryStore();
  await store.upsertSeries([seriesDef('us.m2', 'fred')]);
  await store.recordRun(sourceRun('fred', { status: 'error', error: 'HTTP 500' }));
  await store.recordPipelineRun(pipelineRun());

  const { body } = await app(store)<{
    sources: Array<{ id: string; lastRun: SourceRun | null }>;
    alerts: Array<{ kind: string; subject: string }>;
    pipeline: PipelineRun[];
  }>('/api/sources');

  assert.ok(body.sources.length > 0);
  assert.equal(body.pipeline.length, 1);
  assert.ok(body.alerts.some((a) => a.kind === 'source_failed' && a.subject === 'fred'));
});

/* ------------------------------------------------------------------ health */

test('/api/health answers liveness even when the data is in a bad state', async () => {
  // A monitor asking "is the API up" must not get a failure because a feed is
  // stale. The verdict on the data is one field away.
  const store = new MemoryStore();
  const { status, body } = await app(store)<{ ok: boolean; summary: { critical: number } }>('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.summary.critical > 0, 'and it still reports that the data is not');
});

/* ------------------------------------------------------------------ errors */

test('a route that throws returns a labelled 500 rather than an empty body', async () => {
  // Without this the browser sees a bare 500 and the UI cannot tell the reader
  // whether the API failed or there is simply no data.
  const store = new MemoryStore();
  store.getSeriesHealth = async () => { throw new Error('database is locked'); };

  const { status, body } = await app(store)<{ error: string; kind: string; path: string }>('/api/dashboard');
  assert.equal(status, 500);
  assert.equal(body.kind, 'server_error');
  assert.match(body.error, /database is locked/);
  assert.equal(body.path, '/api/dashboard');
});

test('an unknown pillar or series is a 404 with a message, not a crash', async () => {
  const store = new MemoryStore();
  const get = app(store);
  const pillar = await get<{ error: string }>('/api/pillar/nonsense');
  const series = await get<{ error: string }>('/api/series/nope.nope');
  assert.equal(pillar.status, 404);
  assert.match(pillar.body.error, /nonsense/);
  assert.equal(series.status, 404);
  assert.match(series.body.error, /nope\.nope/);
});

/* ------------------------------------------------------------ freshness */

test('a long-running server picks up new data once the pipeline records a run', async () => {
  // The series cache used to live for the life of the process, so a
  // production API kept serving the numbers it loaded at boot after every
  // daily run until it happened to restart.
  const store = new MemoryStore();
  const get = app(store);
  await store.upsertSeries([seriesDef('fx.broad_dollar', 'fred')]);
  await store.putObservations([{ seriesId: 'fx.broad_dollar', obsDate: '2026-09-01', value: 111.111 }]);
  await store.recordPipelineRun(pipelineRun());
  assert.match(JSON.stringify((await get('/api/markets')).body), /111\.111/);

  await store.putObservations([{ seriesId: 'fx.broad_dollar', obsDate: '2026-09-02', value: 222.222 }]);
  const now = new Date().toISOString();
  await store.recordPipelineRun(pipelineRun({ startedAt: now, finishedAt: now }));
  assert.match(JSON.stringify((await get('/api/markets')).body), /222\.222/, 'the new run invalidates the cache');
});

test('the events limit is clamped, so ?limit=-1 cannot pull the whole table', async () => {
  const store = new MemoryStore();
  let asked: number | undefined;
  store.listEvents = async (f = {}) => { asked = f.limit; return []; };
  const get = app(store);
  await get('/api/events?limit=-1');
  assert.equal(asked, 1);
  await get('/api/events?limit=100000');
  assert.equal(asked, 500);
  await get('/api/events?limit=nonsense');
  assert.equal(asked, 100);
});

/* ---------------------------------------------------------------- healthz */

test('/healthz is 200 when the database answers and 503 when it does not', async () => {
  // The platform's deploy healthcheck. It must depend on the database and on
  // nothing else — a stale feed must never roll back a good release.
  const store = new MemoryStore();
  assert.deepEqual(await app(store)('/healthz'), { status: 200, body: { ok: true } });
  store.ping = async () => { throw new Error('connection refused'); };
  const down = await app(store)<{ ok: boolean }>('/healthz');
  assert.equal(down.status, 503);
  assert.equal(down.body.ok, false);
});
