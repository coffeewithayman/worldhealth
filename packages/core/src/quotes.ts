import { addDays, addYears, daysBetween } from './dates.js';
import { asOf, indexSeries, type IndexedSeries } from './series-math.js';
import { percentileRank } from './stats.js';
import type { IsoDate, Observation } from './types.js';

/**
 * Quote statistics — the numbers a price board needs.
 *
 * Kept in core rather than the API layer because the same arithmetic answers
 * two different questions: "what is this worth today and how has it moved"
 * (the markets board) and "where does today's reading sit in its own history"
 * (the indicator drill-down). Computing it once, server-side, also means the
 * browser never downloads twenty-five years of observations to render an
 * eighty-pixel sparkline.
 */

export interface Change {
  /** Change in the series' own units. */
  abs: number;
  /** Percent change. Meaningless for series that cross zero — see `pctMeaningful`. */
  pct: number;
  /** The earlier value the change was measured against, and its date. */
  fromValue: number;
  fromDate: IsoDate;
}

export type ChangeWindow = 'prev' | 'd1' | 'w1' | 'm1' | 'm3' | 'ytd' | 'y1' | 'y5';

export interface QuoteStats {
  last: { date: IsoDate; value: number } | null;
  /** Days between the last observation and the as-of date. */
  ageDays: number | null;
  changes: Partial<Record<ChangeWindow, Change>>;
  /**
   * False when the series legitimately crosses or sits near zero (spreads,
   * yields, net balances), where a percent change is arithmetic noise — a
   * spread going from +2bp to -2bp is not "-200%". The UI shows the absolute
   * change instead.
   */
  pctMeaningful: boolean;
  range52w: { low: number; high: number; /** 0 = at the low, 1 = at the high. */ pos: number } | null;
  /** Where the latest value sits within its own trailing 5-year distribution, 0-1. */
  percentile5y: number | null;
  /** Downsampled recent history for a sparkline. */
  spark: Array<{ date: IsoDate; value: number }>;
}

const WINDOW_DAYS: Record<Exclude<ChangeWindow, 'prev' | 'ytd'>, number> = {
  d1: 1, w1: 7, m1: 30, m3: 91, y1: 365, y5: 1826,
};

/**
 * Even-stride downsample that always keeps the first and last points.
 *
 * A sparkline drawn from 6,000 daily observations across 200 pixels is 30
 * points per pixel of wasted payload; the shape is identical at 120. Keeping
 * the endpoints matters because the end-dot is the value the reader looks at.
 */
export function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  const stride = (points.length - 1) / (max - 1);
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round(i * stride)]!);
  out.push(points[points.length - 1]!);
  return out;
}

function changeBetween(idx: IndexedSeries, fromDate: IsoDate, current: number): Change | null {
  if (idx.dates.length === 0 || fromDate < idx.dates[0]!) return null;
  const prev = asOf(idx, fromDate);
  if (prev === null || !Number.isFinite(prev)) return null;
  // Locate the date the comparison value actually came from, so the UI can say
  // "vs 2026-07-09" rather than implying an observation exists on a weekend.
  let lo = 0;
  let hi = idx.dates.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx.dates[mid]! <= fromDate) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return {
    abs: current - prev,
    pct: prev === 0 ? NaN : ((current - prev) / Math.abs(prev)) * 100,
    fromValue: prev,
    fromDate: idx.dates[best]!,
  };
}

/**
 * Percent change is only honest for a strictly positive quantity with a
 * meaningful zero.
 *
 * Two failures this rules out. A series that straddles zero: a spread going
 * from +2bp to -2bp is not "-200%". And a series that is entirely negative: a
 * financial-conditions index moving from -0.82 to -0.51 is *less* stress, but
 * the arithmetic reports "+38%", which reads as more. Both report their
 * absolute move instead.
 */
function isPctMeaningful(values: number[]): boolean {
  if (values.length === 0) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (min <= 0) return false;
  const span = max - min;
  return span === 0 || min > span * 0.15;
}

/**
 * Units where a percent change is the wrong idiom.
 *
 * A ten-year yield going from 4.23 to 4.65 is "+42bp" to anyone who trades it,
 * not "+9.9%", and a percent change of a percent invites the reader to confuse
 * the two. Rate-like units always report their absolute move.
 */
export function isRateUnit(unit: string | null | undefined): boolean {
  if (!unit) return false;
  const u = unit.toLowerCase();
  return u === 'percent' || u === 'basis points' || u === 'percentage points'
    || u.startsWith('percent of') || u.startsWith('percent ');
}

/**
 * Typical gap between observations, in days, from the recent tail.
 *
 * Used to suppress change windows the series cannot actually support: a
 * one-day change on a monthly series is computed by carrying last month's
 * value forward, so it reports the same number as the one-month change and
 * implies a daily observation that does not exist.
 */
function typicalGapDays(dates: IsoDate[]): number {
  const n = dates.length;
  if (n < 3) return 1;
  const gaps: number[] = [];
  for (let i = Math.max(1, n - 8); i < n; i++) gaps.push(daysBetween(dates[i - 1]!, dates[i]!));
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 1;
}

export interface QuoteOptions {
  /** As-of date; changes are measured backwards from the last observation. */
  asOf?: IsoDate;
  /** Days of history to include in the sparkline. */
  sparkDays?: number;
  /** Maximum sparkline points after downsampling. */
  sparkPoints?: number;
}

export function computeQuoteStats(obs: Observation[], opts: QuoteOptions = {}): QuoteStats {
  const sparkDays = opts.sparkDays ?? 365;
  const sparkPoints = opts.sparkPoints ?? 96;
  const empty: QuoteStats = {
    last: null, ageDays: null, changes: {}, pctMeaningful: false,
    range52w: null, percentile5y: null, spark: [],
  };
  if (obs.length === 0) return empty;

  const idx = indexSeries(obs);
  const n = idx.dates.length;
  const lastDate = idx.dates[n - 1]!;
  const lastValue = idx.values[n - 1]!;
  const asOfDate = opts.asOf ?? lastDate;

  const changes: Partial<Record<ChangeWindow, Change>> = {};
  if (n > 1) {
    const prevValue = idx.values[n - 2]!;
    changes.prev = {
      abs: lastValue - prevValue,
      pct: prevValue === 0 ? NaN : ((lastValue - prevValue) / Math.abs(prevValue)) * 100,
      fromValue: prevValue,
      fromDate: idx.dates[n - 2]!,
    };
  }
  // Windows shorter than the publication gap would be forward-filled repeats
  // of a longer window, so they are dropped rather than shown as real moves.
  const gap = typicalGapDays(idx.dates);
  for (const [key, days] of Object.entries(WINDOW_DAYS) as Array<[ChangeWindow, number]>) {
    if (days < gap * 0.9) continue;
    const c = changeBetween(idx, addDays(lastDate, -days), lastValue);
    if (c && c.fromDate !== lastDate) changes[key] = c;
  }
  const ytdAnchor = `${lastDate.slice(0, 4)}-01-01`;
  const ytd = changeBetween(idx, ytdAnchor, lastValue);
  if (ytd && ytd.fromDate !== lastDate) changes.ytd = ytd;

  // 52-week range and the 5-year percentile share one scan of the tail.
  const cutoff52 = addDays(lastDate, -365);
  const cutoff5y = addYears(lastDate, -5);
  let low = Infinity;
  let high = -Infinity;
  const window5y: number[] = [];
  const recent: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = idx.dates[i]!;
    if (d < cutoff5y) break;
    const v = idx.values[i]!;
    window5y.push(v);
    if (d >= cutoff52) {
      if (v < low) low = v;
      if (v > high) high = v;
      recent.push(v);
    }
  }

  const sparkCutoff = addDays(lastDate, -sparkDays);
  const sparkAll: Array<{ date: IsoDate; value: number }> = [];
  for (let i = 0; i < n; i++) {
    if (idx.dates[i]! >= sparkCutoff) sparkAll.push({ date: idx.dates[i]!, value: idx.values[i]! });
  }

  return {
    last: { date: lastDate, value: lastValue },
    ageDays: daysBetween(lastDate, asOfDate),
    changes,
    pctMeaningful: isPctMeaningful(recent.length > 1 ? recent : window5y),
    range52w: Number.isFinite(low) && high > low
      ? { low, high, pos: (lastValue - low) / (high - low) }
      : Number.isFinite(low) ? { low, high, pos: 0.5 } : null,
    percentile5y: window5y.length >= 24 ? percentileRank(window5y, lastValue) : null,
    spark: downsample(sparkAll.length > 1 ? sparkAll : [{ date: lastDate, value: lastValue }], sparkPoints),
  };
}
