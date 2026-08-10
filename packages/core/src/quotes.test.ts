import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BOARD, boardSeriesIds, CURVE_POINTS, HEADLINE_ROWS } from './board.js';
import { computeQuoteStats, downsample, isRateUnit } from './quotes.js';
import type { Observation } from './types.js';

/** Daily observations counting back from `end`, weekends included. */
function daily(id: string, end: string, days: number, fn: (i: number) => number): Observation[] {
  const out: Observation[] = [];
  const endMs = Date.parse(`${end}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    out.push({
      seriesId: id,
      obsDate: new Date(endMs - i * 86_400_000).toISOString().slice(0, 10),
      value: fn(days - 1 - i),
    });
  }
  return out;
}

/** Month-start observations, the way every official monthly series is labelled. */
function monthly(id: string, endYear: number, endMonth: number, months: number, fn: (i: number) => number): Observation[] {
  const out: Observation[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(endYear, endMonth - 1 - i, 1));
    out.push({ seriesId: id, obsDate: d.toISOString().slice(0, 10), value: fn(months - 1 - i) });
  }
  return out;
}

/* ------------------------------------------------------------------ windows */

test('change windows shorter than the publication gap are omitted', () => {
  // The failure this prevents: a monthly series' "1-day change" is computed by
  // carrying last month's value forward, so it reports the same number as the
  // 1-month change while implying a daily observation that does not exist.
  const stats = computeQuoteStats(monthly('m', 2026, 6, 36, (i) => 100 + i));
  assert.equal(stats.changes.d1, undefined, 'no one-day change on a monthly series');
  assert.equal(stats.changes.w1, undefined, 'no one-week change on a monthly series');
  assert.ok(stats.changes.m1, 'the one-month change is real and kept');
  assert.ok(stats.changes.y1, 'the one-year change is real and kept');
});

test('a daily series keeps every window', () => {
  const stats = computeQuoteStats(daily('d', '2026-08-07', 800, (i) => 100 + i * 0.1));
  for (const w of ['d1', 'w1', 'm1', 'm3', 'y1'] as const) {
    assert.ok(stats.changes[w], `expected a ${w} change`);
  }
});

test('changes report the date the comparison value actually came from', () => {
  const stats = computeQuoteStats(daily('d', '2026-08-07', 400, () => 50));
  assert.equal(stats.changes.y1?.fromDate, '2025-08-07');
  assert.equal(stats.changes.y1?.abs, 0);
});

/* --------------------------------------------------------------- percentage */

test('percent change is suppressed on a series that crosses zero', () => {
  // A spread going from +2bp to -2bp is not "-200%".
  const spread = daily('s', '2026-08-07', 500, (i) => Math.sin(i / 20) * 30);
  assert.equal(computeQuoteStats(spread).pctMeaningful, false);
});

test('percent change survives on a strictly positive price', () => {
  const price = daily('p', '2026-08-07', 500, (i) => 3000 + i);
  assert.equal(computeQuoteStats(price).pctMeaningful, true);
});

test('percent change is suppressed on an entirely negative index', () => {
  // A financial-conditions index moving from -0.82 to -0.51 is less stress, but
  // the percent arithmetic reports "+38%", which reads as more.
  const nfci = daily('n', '2026-08-07', 500, (i) => -0.9 + (i / 500) * 0.4);
  assert.equal(computeQuoteStats(nfci).pctMeaningful, false);
});

test('isRateUnit catches the units quoted in basis points', () => {
  for (const u of ['percent', 'basis points', 'percentage points', 'percent of accepted']) {
    assert.equal(isRateUnit(u), true, u);
  }
  for (const u of ['USD per troy ounce', 'index', 'ratio', '', null]) {
    assert.equal(isRateUnit(u), false, String(u));
  }
});

/* ------------------------------------------------------------ range & rank */

test('the 52-week range positions the latest value between its own extremes', () => {
  // A saw that ends exactly halfway up its own year.
  const obs = daily('r', '2026-08-07', 400, (i) => (i % 100) + 1);
  const stats = computeQuoteStats(obs);
  assert.ok(stats.range52w);
  assert.equal(stats.range52w!.low, 1);
  assert.equal(stats.range52w!.high, 100);
  const pos = stats.range52w!.pos;
  assert.ok(pos >= 0 && pos <= 1, `position must stay inside the range, got ${pos}`);
});

test('the five-year percentile puts an all-time high at the top', () => {
  const obs = daily('r', '2026-08-07', 1500, (i) => i);
  const stats = computeQuoteStats(obs);
  assert.ok(stats.percentile5y !== null && stats.percentile5y > 0.99);
});

test('a series with too little history reports no percentile rather than a fake one', () => {
  const stats = computeQuoteStats(daily('r', '2026-08-07', 5, (i) => i));
  assert.equal(stats.percentile5y, null);
});

/* ---------------------------------------------------------------- sparkline */

test('downsample keeps the first and last points', () => {
  const xs = Array.from({ length: 1000 }, (_, i) => i);
  const out = downsample(xs, 50);
  assert.equal(out.length, 50);
  assert.equal(out[0], 0);
  assert.equal(out.at(-1), 999, 'the end point is the value the reader looks at');
});

test('downsample is a no-op below the cap', () => {
  const xs = [1, 2, 3];
  assert.deepEqual(downsample(xs, 50), xs);
});

/* -------------------------------------------------------------------- board */

test('every board row and curve point resolves to a series id', () => {
  const ids = new Set(boardSeriesIds());
  for (const g of BOARD) {
    for (const r of g.rows) {
      assert.ok(ids.has(r.seriesId), `${g.id}/${r.seriesId} missing from boardSeriesIds()`);
      if (r.goldSeriesId) assert.ok(ids.has(r.goldSeriesId), `${r.goldSeriesId} missing`);
    }
  }
  for (const p of CURVE_POINTS) assert.ok(ids.has(p.seriesId), `${p.seriesId} missing`);
});

test('every headline row exists on some board', () => {
  const all = new Set(BOARD.flatMap((g) => g.rows.map((r) => r.seriesId)));
  for (const id of HEADLINE_ROWS) {
    assert.ok(all.has(id), `headline row ${id} is not on any board, so it would render blank`);
  }
});

test('board ids and row ids are unique', () => {
  const groupIds = BOARD.map((g) => g.id);
  assert.equal(new Set(groupIds).size, groupIds.length, 'duplicate board id');
  for (const g of BOARD) {
    const ids = g.rows.map((r) => r.seriesId);
    assert.equal(new Set(ids).size, ids.length, `duplicate row in board ${g.id}`);
  }
});
