/**
 * Pure statistics used by the scoring engine.
 *
 * Kept free of I/O so the golden-fixture tests can exercise the model without
 * a database or network.
 */

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1). Returns NaN for fewer than 2 points. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

/**
 * Fraction of `history` at or below `x`, in [0, 1].
 *
 * Ties count as half, so a value sitting exactly on a long flat run (common in
 * policy rates, which sit pinned at zero for years) scores in the middle of
 * that run rather than at its top. Without this, a rate that never moved would
 * read as a 100th-percentile extreme.
 */
export function percentileRank(history: number[], x: number): number {
  const xs = history.filter(Number.isFinite);
  if (xs.length === 0) return NaN;
  let below = 0;
  let equal = 0;
  for (const v of xs) {
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return (below + equal / 2) / xs.length;
}

/** Value at percentile `p` (0-1) using linear interpolation between order statistics. */
export function quantile(values: number[], p: number): number {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return NaN;
  if (xs.length === 1) return xs[0]!;
  const idx = clamp(p, 0, 1) * (xs.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return xs[lo]! * (1 - frac) + xs[hi]! * frac;
}

/**
 * Piecewise-linear mapping through explicit `[inputValue, score]` control points.
 *
 * Used where history is thin or misleading and we know the thresholds that
 * actually matter — e.g. high-yield spreads, where 400bp/800bp/1000bp carry
 * real meaning that a percentile rank of a benign decade would hide.
 * Bands must be sorted ascending by input value; outside the range the nearest
 * endpoint score is held flat.
 */
export function interpolateBands(bands: Array<[number, number]>, x: number): number {
  if (bands.length === 0) return NaN;
  if (bands.length === 1) return bands[0]![1];
  if (x <= bands[0]![0]) return bands[0]![1];
  const last = bands[bands.length - 1]!;
  if (x >= last[0]) return last[1];
  for (let i = 0; i < bands.length - 1; i++) {
    const [x0, y0] = bands[i]!;
    const [x1, y1] = bands[i + 1]!;
    if (x >= x0 && x <= x1) {
      if (x1 === x0) return y1;
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

/**
 * Z-score mapped onto 0-100, clamped at ±`clampSd` standard deviations.
 * A value exactly at the historical mean scores 50.
 */
export function zScoreToScore(history: number[], x: number, clampSd = 3): number {
  const m = mean(history);
  const sd = stdev(history);
  if (!Number.isFinite(m) || !Number.isFinite(sd) || sd === 0) return NaN;
  const z = clamp((x - m) / sd, -clampSd, clampSd);
  return ((z + clampSd) / (2 * clampSd)) * 100;
}

/** Least-squares slope of `ys` against its own index. Units: y per step. */
export function slope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return NaN;
  const xm = (n - 1) / 2;
  const ym = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (ys[i]! - ym);
    den += (i - xm) ** 2;
  }
  return den === 0 ? NaN : num / den;
}

/** Percent change from `prev` to `curr`. Guards division by zero. */
export function pctChange(prev: number, curr: number): number {
  if (!Number.isFinite(prev) || prev === 0) return NaN;
  return ((curr - prev) / Math.abs(prev)) * 100;
}
