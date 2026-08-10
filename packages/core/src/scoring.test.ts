import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { interpolateBands, percentileRank, quantile, zScoreToScore } from './stats.js';
import { asOf, breadthAtHighs, combine, indexSeries, yoyPercent } from './series-math.js';
import { classifyRegime, computeComposite, scoreIndicator, type IndicatorSpec, type SeriesData } from './scoring.js';
import { evaluateWatchlist } from './watchlist.js';
import type { Observation } from './types.js';

/* ------------------------------------------------------------------- stats */

test('percentileRank counts ties as half', () => {
  // 5 sits above one value, tied with three. (1 + 3/2) / 5 = 0.5
  assert.equal(percentileRank([1, 5, 5, 5, 9], 5), 0.5);
  assert.equal(percentileRank([1, 2, 3, 4], 0), 0);
  assert.equal(percentileRank([1, 2, 3, 4], 100), 1);
});

test('percentileRank keeps a long flat run off the extremes', () => {
  // A policy rate pinned at zero for years must not read as a 100th-percentile
  // extreme just because nothing is strictly above it.
  const pinned = [...Array(100).fill(0), 1, 2, 3];
  const p = percentileRank(pinned, 0);
  assert.ok(p > 0.4 && p < 0.55, `expected mid-range, got ${p}`);
});

test('interpolateBands is piecewise linear and clamps outside the range', () => {
  const bands: Array<[number, number]> = [[0, 0], [10, 50], [20, 100]];
  assert.equal(interpolateBands(bands, 0), 0);
  assert.equal(interpolateBands(bands, 5), 25);
  assert.equal(interpolateBands(bands, 10), 50);
  assert.equal(interpolateBands(bands, 15), 75);
  assert.equal(interpolateBands(bands, -99), 0, 'below range holds the first score');
  assert.equal(interpolateBands(bands, 999), 100, 'above range holds the last score');
});

test('interpolateBands represents non-monotonic (U-shaped) risk', () => {
  // The M2 case: both contraction and explosion are dangerous, healthy is in
  // the middle. A percentile rank structurally cannot express this.
  const m2: Array<[number, number]> = [[-6, 100], [0, 82], [5, 25], [20, 85]];
  assert.ok(interpolateBands(m2, -3) > 85, 'contraction scores high');
  assert.ok(interpolateBands(m2, 5) < 30, 'healthy growth scores low');
  assert.ok(interpolateBands(m2, 18) > 70, 'runaway growth scores high again');
});

test('zScoreToScore centres the mean at 50', () => {
  const history = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.equal(Math.round(zScoreToScore(history, 5)), 50);
  assert.ok(zScoreToScore(history, 100) === 100, 'clamped above');
  assert.ok(zScoreToScore(history, -100) === 0, 'clamped below');
});

test('quantile interpolates between order statistics', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([0, 10], 0.25), 2.5);
});

/* -------------------------------------------------------------- series math */

const obs = (id: string, rows: Array<[string, number]>): Observation[] =>
  rows.map(([obsDate, value]) => ({ seriesId: id, obsDate, value }));

test('asOf forward-fills and never back-fills', () => {
  const s = indexSeries(obs('x', [['2024-01-01', 10], ['2024-03-01', 20]]));
  assert.equal(asOf(s, '2024-02-15'), 10, 'carries the last known value forward');
  assert.equal(asOf(s, '2024-03-01'), 20);
  assert.equal(asOf(s, '2023-12-31'), null, 'refuses to invent history before the series starts');
});

test('combine aligns mixed frequencies on the primary grid', () => {
  const daily = obs('d', [['2024-01-01', 100], ['2024-01-02', 200], ['2024-01-03', 300]]);
  const monthly = obs('m', [['2024-01-01', 2]]);
  const out = combine(daily, [monthly], (a, [b]) => a / b!);
  assert.deepEqual(out.map((o) => o.value), [50, 100, 150]);
});

test('yoyPercent computes year-over-year change', () => {
  const s = obs('x', [['2023-01-01', 100], ['2024-01-01', 110]]);
  const out = yoyPercent(s);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0]!.value - 10) < 0.001);
});

test('breadthAtHighs measures how many series sit at their own highs', () => {
  const rising = obs('a', [['2024-01-01', 1], ['2024-06-01', 2], ['2024-12-01', 3]]);
  const falling = obs('b', [['2024-01-01', 3], ['2024-06-01', 2], ['2024-12-01', 1]]);
  const flat = obs('c', [['2024-01-01', 1], ['2024-06-01', 1], ['2024-12-01', 1]]);
  const out = breadthAtHighs([rising, falling, flat], 365);
  const last = out.at(-1)!;
  // 'rising' is at its high; 'flat' ties its own high; 'falling' is not.
  assert.ok(last.value > 60 && last.value < 70, `expected ~66%, got ${last.value}`);
});

/* ----------------------------------------------------------- point-in-time */

test('scoreIndicator never sees data after the as-of date', () => {
  // The whole backtest depends on this: replaying 2008 must not let the model
  // rank today's value against a distribution that includes 2009.
  const spec: IndicatorSpec = {
    seriesId: 'x', label: 'x', pillar: 'credit', weight: 1,
    direction: 'high', maxAgeDays: 4000,
    transform: { kind: 'percentile', lookbackYears: 25 },
  };
  const rows: Array<[string, number]> = [];
  for (let i = 0; i < 100; i++) rows.push([`2020-${String(1 + (i % 12)).padStart(2, '0')}-01`, i]);
  rows.push(['2021-01-01', 5]);
  // A huge future value that must be invisible when scoring as of 2021-01-01.
  rows.push(['2022-01-01', 100000]);

  const data: SeriesData = new Map([['x', obs('x', rows)]]);
  const r = scoreIndicator(spec, data, '2021-01-01');
  assert.ok(!('missing' in r), 'should produce a score');
  if ('missing' in r) return;
  assert.equal(r.rawValue, 5, 'uses the latest value at or before the as-of date');
  assert.ok(r.explanation.includes('percentile'), 'explanation states the arithmetic');
});

test('scoreIndicator drops stale inputs rather than treating them as current', () => {
  const spec: IndicatorSpec = {
    seriesId: 'x', label: 'x', pillar: 'credit', weight: 1,
    direction: 'high', maxAgeDays: 10,
    transform: { kind: 'bands', bands: [[0, 0], [10, 100]] },
  };
  const data: SeriesData = new Map([['x', obs('x', [['2020-01-01', 5]])]]);
  const r = scoreIndicator(spec, data, '2024-01-01');
  assert.ok('missing' in r, 'a four-year-old observation must not be scored as current');
});

test('direction: low inverts the percentile', () => {
  const rows: Array<[string, number]> = [];
  for (let i = 0; i < 60; i++) rows.push([`2020-01-${String(1 + i % 28).padStart(2, '0')}`, i]);
  rows.push(['2021-01-01', 0]); // the minimum
  const data: SeriesData = new Map([['x', obs('x', rows)]]);

  const base = { seriesId: 'x', label: 'x', pillar: 'credit' as const, weight: 1, maxAgeDays: 4000,
    transform: { kind: 'percentile' as const, lookbackYears: 25 } };
  const high = scoreIndicator({ ...base, direction: 'high' }, data, '2021-01-01');
  const low = scoreIndicator({ ...base, direction: 'low' }, data, '2021-01-01');
  assert.ok(!('missing' in high) && !('missing' in low));
  if ('missing' in high || 'missing' in low) return;
  assert.ok(high.score < 20, 'the minimum is a low score when high = stress');
  assert.ok(low.score > 80, 'the same value is a high score when low = stress');
});

/* ------------------------------------------------------------- aggregation */

test('a pillar below the coverage floor is excluded from the composite', () => {
  const specs: IndicatorSpec[] = [
    { seriesId: 'present', label: 'p', pillar: 'credit', weight: 1, direction: 'high', maxAgeDays: 4000,
      transform: { kind: 'bands', bands: [[0, 0], [1, 100]] } },
    { seriesId: 'absent1', label: 'a1', pillar: 'credit', weight: 5, direction: 'high', maxAgeDays: 4000,
      transform: { kind: 'bands', bands: [[0, 0], [1, 100]] } },
    { seriesId: 'absent2', label: 'a2', pillar: 'credit', weight: 5, direction: 'high', maxAgeDays: 4000,
      transform: { kind: 'bands', bands: [[0, 0], [1, 100]] } },
  ];
  const data: SeriesData = new Map([['present', obs('present', [['2024-01-01', 1]])]]);
  const c = computeComposite(specs, data, '2024-01-02');
  const credit = c.pillars.find((p) => p.pillar === 'credit')!;
  assert.ok(credit.coverage < 0.34, `coverage ${credit.coverage} should be below the floor`);
  assert.ok(!Number.isFinite(c.score), 'a composite built only from an under-covered pillar is not reported');
  assert.equal(credit.missing.length, 2, 'missing inputs are counted, not silently dropped');
});

test('pillar score is the weighted mean of its indicators', () => {
  const specs: IndicatorSpec[] = [
    { seriesId: 'a', label: 'a', pillar: 'credit', weight: 3, direction: 'high', maxAgeDays: 4000,
      transform: { kind: 'bands', bands: [[0, 0], [1, 100]] } },
    { seriesId: 'b', label: 'b', pillar: 'credit', weight: 1, direction: 'high', maxAgeDays: 4000,
      transform: { kind: 'bands', bands: [[0, 0], [1, 100]] } },
  ];
  const data: SeriesData = new Map([
    ['a', obs('a', [['2024-01-01', 1]])],   // scores 100
    ['b', obs('b', [['2024-01-01', 0]])],   // scores 0
  ]);
  const c = computeComposite(specs, data, '2024-01-02');
  const credit = c.pillars.find((p) => p.pillar === 'credit')!;
  assert.equal(credit.score, 75, '(100*3 + 0*1) / 4 = 75');
});

test('classifyRegime escalates on breadth as well as level', () => {
  assert.equal(classifyRegime(10, 0), 'Calm');
  assert.equal(classifyRegime(35, 0), 'Watchful');
  // Breadth alone escalates: five stressed pillars is systemic even if the
  // weighted average is unremarkable.
  assert.equal(classifyRegime(20, 5), 'Crisis');
  assert.equal(classifyRegime(80, 0), 'Crisis');
});

/* --------------------------------------------------------------- watchlist */

test('watchlist reports unavailable rather than clear when inputs are missing', () => {
  const results = evaluateWatchlist(new Map(), '2024-01-01');
  assert.equal(results.length, 10);
  for (const r of results) {
    assert.equal(r.available, false, `${r.id} should be unavailable`);
    assert.equal(r.triggered, false);
  }
  // The distinction that matters: "we cannot tell" must never render as "safe".
  assert.ok(results.every((r) => !r.available && !r.triggered));
});

test('M2 contraction triggers only on a negative reading', () => {
  const calm: SeriesData = new Map([['d.m2_yoy', obs('d.m2_yoy', [['2024-01-01', 4]])]]);
  const crisis: SeriesData = new Map([['d.m2_yoy', obs('d.m2_yoy', [['2024-01-01', -3]])]]);

  const a = evaluateWatchlist(calm, '2024-01-02').find((r) => r.id === 'm2_contraction')!;
  const b = evaluateWatchlist(crisis, '2024-01-02').find((r) => r.id === 'm2_contraction')!;
  assert.equal(a.triggered, false);
  assert.equal(b.triggered, true);
  assert.ok(b.severity > a.severity);
});

test('swap-line watchlist trips on a material drawing', () => {
  const quiet: SeriesData = new Map([['us.cb_liquidity_swaps', obs('s', [['2024-01-01', 50]])]]);
  const stressed: SeriesData = new Map([['us.cb_liquidity_swaps', obs('s', [['2024-01-01', 400_000]])]]);
  const a = evaluateWatchlist(quiet, '2024-01-02').find((r) => r.id === 'swap_lines_drawn')!;
  const b = evaluateWatchlist(stressed, '2024-01-02').find((r) => r.id === 'swap_lines_drawn')!;
  assert.equal(a.triggered, false, '$50m is noise');
  assert.equal(b.triggered, true, '$400bn is a crisis');
  assert.equal(b.severity, 100);
});
