import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeAlerts, MemoryStore, type Store } from '@wd/core';
import { runStage } from './stage.js';

/* ------------------------------------------------------------- happy path */

test('a clean stage records ok with its counts', async () => {
  const store = new MemoryStore();
  const out = await runStage(store, 'ingest', async () => ({
    result: 'done', okCount: 9, rowsWritten: 1200,
  }));

  assert.equal(out, 'done');
  const [run] = store.allPipelineRuns();
  assert.equal(run!.status, 'ok');
  assert.equal(run!.okCount, 9);
  assert.equal(run!.rowsWritten, 1200);
  assert.equal(run!.error, null);
  assert.ok(run!.finishedAt >= run!.startedAt);
});

test('failed units make the run partial and are named for the alert engine', async () => {
  const store = new MemoryStore();
  await runStage(store, 'derive', async () => ({
    result: null,
    okCount: 48,
    failed: [{ id: 'd.gold_breadth', error: 'no input rows' }],
  }));

  const [run] = store.allPipelineRuns();
  assert.equal(run!.status, 'partial');
  assert.equal(run!.failCount, 1);
  assert.match(run!.error!, /d\.gold_breadth/);
  assert.deepEqual((run!.detail as { failed: Array<{ id: string }> }).failed.map((f) => f.id), ['d.gold_breadth']);
});

/* ----------------------------------------------------------------- throws */

test('a stage that throws is recorded and the throw still propagates', async () => {
  // Both halves matter: the dashboard needs the row, and the scheduler needs
  // the non-zero exit. Swallowing the error to record it would lose the second.
  const store = new MemoryStore();
  await assert.rejects(
    () => runStage(store, 'score', async () => { throw new TypeError('cannot read length of undefined'); }),
    /cannot read length/,
  );

  const [run] = store.allPipelineRuns();
  assert.equal(run!.status, 'error');
  assert.match(run!.error!, /TypeError: cannot read length/);
  assert.equal(run!.rowsWritten, 0);
});

test('a crashed stage surfaces as a critical alert on the dashboard', async () => {
  // The end-to-end claim this whole mechanism exists to make: a stage dies, and
  // the page says so instead of serving the last good score in silence.
  const store: Store = new MemoryStore();
  await assert.rejects(() => runStage(store, 'derive', async () => { throw new Error('boom'); }));

  const alerts = computeAlerts({
    pipelineRuns: await store.getLatestPipelineRuns(),
    sourceRuns: [],
    connectors: [],
    series: [],
    health: [],
  });
  const failed = alerts.find((a) => a.kind === 'pipeline_failed');
  assert.ok(failed, 'the crash must reach the alert list');
  assert.equal(failed!.severity, 'critical');
  assert.match(failed!.detail, /boom/);
});

test('a store that cannot record the run does not replace the original error', async () => {
  // The recording is diagnostics; the original exception is the diagnosis.
  const store = new MemoryStore();
  store.recordPipelineRun = async () => { throw new Error('database is locked'); };

  await assert.rejects(
    () => runStage(store, 'ingest', async () => { throw new Error('the real problem'); }),
    /the real problem/,
  );
});

/* ---------------------------------------------------------------- dry runs */

test('an explicit status overrides the inferred one', async () => {
  // A dry run must not leave a row claiming the data was updated.
  const store = new MemoryStore();
  await runStage(store, 'ingest', async () => ({ result: null, status: 'skipped' as const, rowsWritten: 0 }));
  assert.equal(store.allPipelineRuns()[0]!.status, 'skipped');
});

test('nested stages each record their own row', async () => {
  // `daily` wraps ingest, derive and score: the outer row proves the scheduler
  // fired, the inner rows say which step failed.
  const store = new MemoryStore();
  await runStage(store, 'daily', async () => {
    await runStage(store, 'ingest', async () => ({ result: null, okCount: 9 }));
    await runStage(store, 'derive', async () => ({ result: null, okCount: 48 }));
    return { result: null, okCount: 57 };
  });

  assert.deepEqual(store.allPipelineRuns().map((r) => r.stage), ['ingest', 'derive', 'daily']);
  assert.deepEqual((await store.getLatestPipelineRuns()).map((r) => r.stage).sort(), ['daily', 'derive', 'ingest']);
});
