import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Http, NullCache, createLogger } from '@wd/core';
import type { FetchCtx } from '@wd/core';
import { FRED_CATALOG, fredConnector } from './fred.js';

/**
 * Staleness budgets, and the arithmetic they are supposed to encode.
 *
 * FRED labels an observation at the *start* of the period it covers, so the age
 * of the newest observation peaks immediately before the next release rather
 * than after it. Budgets set to "roughly a cadence plus a bit" therefore fire
 * every single period on data that is perfectly current — which is how a stale
 * badge stops meaning anything.
 */

const byId = new Map(FRED_CATALOG.map((s) => [s.id, s]));
const budget = (id: string): number => {
  const s = byId.get(id);
  assert.ok(s, `${id} is missing from the FRED catalogue`);
  return s.stalenessBudgetDays;
};

test('a period-start label leaves at least a full extra period in every budget', () => {
  // The structural floor, independent of any one publisher's calendar: two
  // consecutive period-start labels are ~62 days apart for a monthly series and
  // ~184 for a quarterly one, so a budget below that cannot survive even a
  // same-day release.
  const floors: Record<string, number> = { monthly: 62, quarterly: 184 };
  for (const s of FRED_CATALOG) {
    const floor = floors[s.cadence];
    if (floor === undefined) continue;
    assert.ok(
      s.stalenessBudgetDays > floor,
      `${s.id}: ${s.stalenessBudgetDays}d cannot cover a ${s.cadence} series labelled at period start (floor ${floor}d)`,
    );
  }
});

test('series that publish late in the following month are budgeted for it', () => {
  // Peak age is roughly 61 + the release day-of-month. Core PCE lands around
  // the 26th, so its newest observation reaches ~87 days old before the next
  // one arrives; at the old budget of 80 it was flagged every month from about
  // the 14th onwards.
  for (const id of ['us.core_pce', 'us.m2', 'us.monetary_base', 'us.months_supply_homes']) {
    assert.ok(budget(id) >= 90, `${id}: needs ~87d of headroom, has ${budget(id)}d`);
  }
});

test('the IMF commodity panel shares one budget, because it shares one release', () => {
  const panel = FRED_CATALOG.filter((s) => s.id.startsWith('cmd.'));
  assert.ok(panel.length >= 8, 'the panel should not have silently shrunk');
  const budgets = new Set(panel.map((s) => s.stalenessBudgetDays));
  assert.equal(budgets.size, 1, 'one upstream release means one budget: they go stale together or not at all');
  assert.ok([...budgets][0]! >= 95, 'August was still unpublished on 20 September, so ~81d of age is normal');
});

test('the trade balance is budgeted for its two-month publication lag', () => {
  // BEA releases month M around the 5th of month M+2 — nearly a month later
  // than any other monthly series here.
  assert.ok(budget('us.trade_balance') >= 100, `has ${budget('us.trade_balance')}d, needs ~97d`);
});

test('the two quarterly stragglers are budgeted apart from their siblings', () => {
  // On 2026-09-20 every other quarterly FRED series had Q2 data; these two had
  // only Q1, 262 days old and still the newest FRED served.
  for (const id of ['us.federal_debt', 'us.debt_service_ratio']) {
    assert.ok(budget(id) > 262, `${id}: ${budget(id)}d is inside an observed-healthy age of 262d`);
  }
});

/* ---------------------------------------------------------------- retirement */

test('a discontinued series is retired rather than left to rot', () => {
  const npl = byId.get('us.nonperforming_loans');
  assert.equal(npl?.retired, '2020-07-01', 'FRED published nothing after this date');
});

test('retired series are declared but never fetched', async () => {
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const id = new URL(String(url)).searchParams.get('series_id');
    if (id) requested.push(id);
    return new Response(JSON.stringify({
      observations: [{ date: '2026-09-01', value: '1.0' }],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const logger = createLogger('test', { level: 'silent' });
    const ctx: FetchCtx = {
      since: '2026-05-23',
      today: '2026-09-20',
      http: new Http(new NullCache(), 'fred', { defaultCacheTtlHours: 0, userAgent: 'test', noCache: true, logger }),
      env: { FRED_API_KEY: 'test-key' },
      log: () => {},
    };
    const result = await fredConnector.run(ctx);

    assert.ok(!requested.includes('NPTLTL'), 'a request that can only ever return nothing is a wasted request');
    assert.ok(requested.length > 50, 'the rest of the catalogue must still be fetched');

    // Declared anyway: this is the write that carries `retiredAt` into the
    // database, and it is what turns the permanent stale alert off.
    const npl = result.series.find((s) => s.id === 'us.nonperforming_loans');
    assert.equal(npl?.retiredAt, '2020-07-01');
    assert.ok(
      !result.observations.some((o) => o.seriesId === 'us.nonperforming_loans'),
      'a retired series contributes no new observations',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FRED fetches only the requested series when given a filter', async () => {
  // How a new catalogue entry is backfilled: one request, not ninety-odd.
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const id = new URL(String(url)).searchParams.get('series_id');
    if (id) requested.push(id);
    return new Response(JSON.stringify({ observations: [{ date: '2001-01-01', value: '1.0' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const target = FRED_CATALOG.find((s) => !s.retired)!;
    const result = await fredConnector.run({
      since: '2001-09-21',
      today: '2026-09-21',
      seriesIds: new Set([target.id]),
      http: new Http(new NullCache(), 'fred', {
        defaultCacheTtlHours: 0, userAgent: 'test', noCache: true, logger: createLogger('test', { level: 'silent' }),
      }),
      env: { FRED_API_KEY: 'test-key' },
      log: () => {},
    });
    assert.deepEqual(requested, [target.fred]);
    assert.ok(result.series.some((s) => s.id === target.id));
  } finally {
    globalThis.fetch = realFetch;
  }
});
