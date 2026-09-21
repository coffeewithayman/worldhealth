import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MemoryStore, addYears, todayIso,
  type Connector, type ConnectorResult, type FetchCtx, type SeriesDef,
} from '@wd/core';
import { pendingBackfills, runPendingBackfills } from './backfill.js';
import { runAll } from './runner.js';

function def(id: string, sourceId: string, over: Partial<SeriesDef> = {}): SeriesDef {
  return {
    id, name: id, unit: 'index', cadence: 'daily', sourceId, pillar: 'monetary',
    stalenessBudgetDays: 7, ...over,
  };
}

/**
 * A connector with a fixed catalogue that honours `seriesIds` the way FRED
 * does, and records every context it was run with.
 */
function catalogue(id: string, ids: string[], opts: { fail?: boolean } = {}) {
  const calls: FetchCtx[] = [];
  const connector: Connector = {
    id, name: id, homepage: 'https://example.test', cadence: 'daily',
    async run(ctx): Promise<ConnectorResult> {
      calls.push(ctx);
      if (opts.fail) throw new Error('upstream down');
      const wanted = ids.filter((s) => !ctx.seriesIds || ctx.seriesIds.has(s));
      return {
        series: wanted.map((s) => def(s, id)),
        observations: wanted.map((s) => ({ seriesId: s, obsDate: ctx.since, value: 1 })),
      };
    },
  };
  return { connector, calls };
}

test('a series added to a catalogue is backfilled on the next daily, and only that series', async () => {
  // The whole point: adding a catalogue entry and merging is the procedure.
  const store = new MemoryStore();
  const v1 = catalogue('fred', ['us.a', 'us.b']);
  await runAll([v1.connector], store, { since: '2026-05-01' });
  await store.markBackfilled(['us.a', 'us.b'], '2026-09-01T00:00:00Z', '2001-09-01');

  // Next deploy adds us.c. Daily's ingest declares it with 120 days of data…
  const v2 = catalogue('fred', ['us.a', 'us.b', 'us.c']);
  await runAll([v2.connector], store, { since: '2026-05-23' });
  assert.deepEqual(Object.fromEntries(await pendingBackfills(store, [v2.connector])), { fred: ['us.c'] });

  // …and the backfill step fetches 25 years of us.c alone.
  const { outcomes, pendingSeries } = await runPendingBackfills(store, [v2.connector]);
  assert.equal(pendingSeries, 1);
  assert.equal(outcomes[0]?.status, 'ok');
  const ctx = v2.calls.at(-1)!;
  assert.deepEqual([...ctx.seriesIds!], ['us.c']);
  assert.equal(ctx.since, addYears(todayIso(), -25));
  assert.equal((await store.getObservations('us.c'))[0]?.obsDate, addYears(todayIso(), -25));

  // Done is done: the next run finds nothing to do and fetches nothing.
  const calls = v2.calls.length;
  assert.equal((await runPendingBackfills(store, [v2.connector])).pendingSeries, 0);
  assert.equal(v2.calls.length, calls);
});

test('a new source fills in with no manual step', async () => {
  const store = new MemoryStore();
  const fresh = catalogue('newsource', ['new.x', 'new.y']);
  await runAll([fresh.connector], store, { since: '2026-05-23' });
  await runPendingBackfills(store, [fresh.connector]);
  assert.deepEqual([...await store.getBackfilledSeries()].sort(), ['new.x', 'new.y']);
});

test('a failed backfill marks nothing, so it is retried tomorrow', async () => {
  const store = new MemoryStore();
  await store.upsertSeries([def('eia.a', 'eia')]);
  const down = catalogue('eia', ['eia.a'], { fail: true });
  const { outcomes } = await runPendingBackfills(store, [down.connector]);
  assert.equal(outcomes[0]?.status, 'error');
  assert.deepEqual([...await store.getBackfilledSeries()], []);
  assert.deepEqual(Object.fromEntries(await pendingBackfills(store, [down.connector])), { eia: ['eia.a'] });
});

test('retired, derived and orphaned series are never pending', async () => {
  // Retired: never fetched. Derived: no connector, recomputed in full each
  // derive. Orphaned: its connector was removed from the registry.
  const store = new MemoryStore();
  await store.upsertSeries([
    def('us.live', 'fred'),
    def('us.dead', 'fred', { retiredAt: '2020-07-01' }),
    def('d.spread', 'derived'),
    def('old.x', 'removed-source'),
  ]);
  const fred = catalogue('fred', ['us.live']);
  assert.deepEqual(Object.fromEntries(await pendingBackfills(store, [fred.connector])), { fred: ['us.live'] });
});
