import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MemoryCache, MemoryStore, type Connector, type ConnectorResult, type FetchCtx } from '@wd/core';
import { runAll, runConnector } from './runner.js';

const SINCE = '2026-01-01';

function connector(id: string, run: (ctx: FetchCtx) => Promise<ConnectorResult>, over: Partial<Connector> = {}): Connector {
  return {
    id,
    name: `Source ${id}`,
    homepage: 'https://example.test',
    cadence: 'daily',
    run,
    ...over,
  };
}

/** A connector returning one series and one observation. */
function working(id: string, rows = 1): Connector {
  return connector(id, async () => ({
    series: [{
      id: `${id}.a`, name: 'A', unit: 'index', cadence: 'daily',
      sourceId: id, pillar: 'monetary', stalenessBudgetDays: 7,
    }],
    observations: Array.from({ length: rows }, (_, i) => ({
      seriesId: `${id}.a`, obsDate: `2026-09-${String(i + 1).padStart(2, '0')}`, value: i,
    })),
  }));
}

function broken(id: string, message = 'upstream exploded'): Connector {
  return connector(id, async () => { throw new Error(message); });
}

/* ------------------------------------------------------------- isolation */

test('one broken connector does not stop the others', async () => {
  // The invariant the whole registry rests on: ~40 independent sources, and a
  // dashboard that loses 39 of them because one 500s is worthless.
  const store = new MemoryStore();
  const results = await runAll(
    [working('a'), broken('b'), working('c')],
    store, { since: SINCE },
  );

  assert.deepEqual(results.map((r) => `${r.sourceId}:${r.status}`), ['a:ok', 'b:error', 'c:ok']);
  assert.equal((await store.getObservations('a.a')).length, 1);
  assert.equal((await store.getObservations('c.a')).length, 1);
});

test('a failure is written to source_runs — that is what the Sources tab reads', async () => {
  const store = new MemoryStore();
  await runConnector(broken('b', 'HTTP 503 from example.test'), store, { since: SINCE });

  const [run] = await store.getLatestRuns();
  assert.equal(run!.status, 'error');
  assert.match(run!.error!, /503/);
  assert.equal(run!.rowsWritten, 0);
});

test('a connector needing an absent key is skipped, not failed', async () => {
  // "Broken" and "not configured" are different problems with different fixes,
  // and the alert engine leans on the distinction.
  const store = new MemoryStore();
  const out = await runConnector(
    working('needs-key'), store, { since: SINCE },
  );
  assert.equal(out.status, 'ok', 'no key declared, so it runs');

  const gated = await runConnector(
    connector('gated', async () => { throw new Error('should never run'); }, { requiresKey: 'WD_TEST_ABSENT_KEY' }),
    store, { since: SINCE },
  );
  assert.equal(gated.status, 'skipped');
  assert.match(gated.error!, /WD_TEST_ABSENT_KEY/);
});

test('--force runs a keyless connector anyway so the failure is explicit', async () => {
  const store = new MemoryStore();
  const out = await runConnector(
    connector('gated', async () => { throw new Error('401 unauthorized'); }, { requiresKey: 'WD_TEST_ABSENT_KEY' }),
    store, { since: SINCE, force: true },
  );
  assert.equal(out.status, 'error');
  assert.match(out.error!, /401/);
});

/* --------------------------------------------------------------- outcomes */

test('warnings downgrade a run to partial without losing its rows', async () => {
  const store = new MemoryStore();
  const out = await runConnector(
    connector('w', async () => ({
      ...(await working('w').run({} as FetchCtx)),
      warnings: ['series 3 of 4 returned 404'],
    })),
    store, { since: SINCE },
  );

  assert.equal(out.status, 'partial');
  assert.equal(out.rows, 1, 'a partial run still keeps what it did fetch');
  const [run] = await store.getLatestRuns();
  assert.equal(run!.status, 'partial');
  assert.match(run!.error!, /404/, 'the warning is preserved for the UI');
});

test('a dry run writes neither observations nor a run row', async () => {
  // `doctor` exists to answer "is this feed alive" without touching the data.
  const store = new MemoryStore();
  const out = await runConnector(working('a', 3), store, { since: SINCE, dryRun: true });

  assert.equal(out.status, 'ok');
  assert.equal(out.rows, 3, 'it still reports what it parsed');
  assert.equal((await store.getObservations('a.a')).length, 0);
  assert.equal(store.allRuns().length, 0);
});

test('a successful run marks its series as freshly loaded', async () => {
  const store = new MemoryStore();
  await runConnector(working('a'), store, { since: SINCE });
  const [health] = await store.getSeriesHealth();
  assert.equal(health!.seriesId, 'a.a');
  assert.ok(health!.lastSuccessAt, 'without this the series looks never-loaded on the Sources tab');
});

/* ------------------------------------------------------------ concurrency */

test('runAll bounds concurrency and still returns every source', async () => {
  // Unbounded would trip the per-IP rate limits several of these APIs share.
  const store = new MemoryStore();
  let live = 0;
  let peak = 0;
  const slow = (id: string) => connector(id, async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return { series: [], observations: [] };
  });

  const results = await runAll(
    Array.from({ length: 9 }, (_, i) => slow(`s${i}`)),
    store, { since: SINCE }, 3,
  );
  assert.equal(results.length, 9);
  assert.ok(peak <= 3, `concurrency cap exceeded: ${peak}`);
});

test('results come back sorted by source id however they finished', async () => {
  const store = new MemoryStore();
  const results = await runAll([working('z'), working('a'), working('m')], store, { since: SINCE });
  assert.deepEqual(results.map((r) => r.sourceId), ['a', 'm', 'z']);
});

/* ------------------------------------------------------------------ cache */

test('a dry run leaves the response cache untouched', async () => {
  // `doctor` announces "(no writes)"; it used to fill raw_cache all the same.
  const cache = new MemoryCache();
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
  try {
    const fetching = connector('f', async (ctx) => {
      await ctx.http.getText('https://example.test/data');
      return { series: [], observations: [] };
    });
    await runConnector(fetching, new MemoryStore(), { since: SINCE, dryRun: true, cache });
    assert.deepEqual(cache.keys(), [], 'a dry run must not write');
    await runConnector(fetching, new MemoryStore(), { since: SINCE, cache });
    assert.equal(cache.keys().length, 1, 'a real run does');
  } finally {
    globalThis.fetch = real;
  }
});
