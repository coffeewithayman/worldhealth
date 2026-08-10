import type { IsoDate, Observation } from './types.js';

/** A series indexed for fast as-of lookup. */
export interface IndexedSeries {
  dates: IsoDate[];
  values: number[];
}

export function indexSeries(obs: Observation[]): IndexedSeries {
  const sorted = [...obs].sort((a, b) => (a.obsDate < b.obsDate ? -1 : a.obsDate > b.obsDate ? 1 : 0));
  return {
    dates: sorted.map((o) => o.obsDate),
    values: sorted.map((o) => o.value),
  };
}

/**
 * Most recent value at or before `date` — a forward fill.
 *
 * This is what makes mixed-frequency arithmetic possible: dividing daily gold
 * by monthly copper is only meaningful if the monthly value is carried forward
 * rather than interpolated, because the published figure genuinely is the last
 * known value until the next release.
 *
 * Returns null when `date` precedes the series start, so we never fabricate
 * history by back-filling.
 */
export function asOf(s: IndexedSeries, date: IsoDate): number | null {
  const { dates, values } = s;
  if (dates.length === 0 || date < dates[0]!) return null;
  let lo = 0;
  let hi = dates.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= date) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best === -1 ? null : values[best]!;
}

/**
 * Combine series pointwise on the date grid of the first, forward-filling the rest.
 *
 * `maxStaleDays` guards against carrying a dead series forward indefinitely: if
 * the most recent underlying observation is older than this, the point is
 * dropped rather than silently repeating a months-old value as if it were current.
 */
export function combine(
  primary: Observation[],
  others: Observation[][],
  fn: (primaryValue: number, otherValues: number[]) => number,
  maxStaleDays = 400,
): Array<{ obsDate: IsoDate; value: number }> {
  const idx = others.map(indexSeries);
  const lastDates = idx.map((s) => s.dates.at(-1) ?? '0000-00-00');
  const out: Array<{ obsDate: IsoDate; value: number }> = [];

  for (const p of [...primary].sort((a, b) => (a.obsDate < b.obsDate ? -1 : 1))) {
    const vals: number[] = [];
    let ok = true;
    for (let i = 0; i < idx.length; i++) {
      const v = asOf(idx[i]!, p.obsDate);
      if (v === null) { ok = false; break; }
      // Only enforce staleness once the input series has genuinely ended.
      if (p.obsDate > lastDates[i]! && daysApart(lastDates[i]!, p.obsDate) > maxStaleDays) { ok = false; break; }
      vals.push(v);
    }
    if (!ok) continue;
    const value = fn(p.value, vals);
    if (Number.isFinite(value)) out.push({ obsDate: p.obsDate, value });
  }
  return out;
}

/**
 * Year-over-year percent change.
 *
 * Uses as-of lookup rather than positional offset so it works identically on
 * daily, weekly and monthly series without knowing which it has.
 */
export function yoyPercent(obs: Observation[], lagDays = 365): Array<{ obsDate: IsoDate; value: number }> {
  const idx = indexSeries(obs);
  const out: Array<{ obsDate: IsoDate; value: number }> = [];
  for (let i = 0; i < idx.dates.length; i++) {
    const date = idx.dates[i]!;
    const prevDate = shiftDays(date, -lagDays);
    if (prevDate < idx.dates[0]!) continue;
    const prev = asOf(idx, prevDate);
    const curr = idx.values[i]!;
    if (prev === null || prev === 0) continue;
    out.push({ obsDate: date, value: ((curr - prev) / Math.abs(prev)) * 100 });
  }
  return out;
}

/** Absolute change over a trailing window, in the series' own units. */
export function changeOver(obs: Observation[], lagDays: number): Array<{ obsDate: IsoDate; value: number }> {
  const idx = indexSeries(obs);
  const out: Array<{ obsDate: IsoDate; value: number }> = [];
  for (let i = 0; i < idx.dates.length; i++) {
    const date = idx.dates[i]!;
    const prevDate = shiftDays(date, -lagDays);
    if (prevDate < idx.dates[0]!) continue;
    const prev = asOf(idx, prevDate);
    if (prev === null) continue;
    out.push({ obsDate: date, value: idx.values[i]! - prev });
  }
  return out;
}

/** Trailing mean over a day-denominated window (not a fixed number of points). */
export function rollingMean(obs: Observation[], windowDays: number): Array<{ obsDate: IsoDate; value: number }> {
  const sorted = [...obs].sort((a, b) => (a.obsDate < b.obsDate ? -1 : 1));
  const out: Array<{ obsDate: IsoDate; value: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const end = sorted[i]!.obsDate;
    const start = shiftDays(end, -windowDays);
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0; j--) {
      if (sorted[j]!.obsDate < start) break;
      sum += sorted[j]!.value;
      n++;
    }
    if (n > 0) out.push({ obsDate: end, value: sum / n });
  }
  return out;
}

/**
 * For each date, the fraction of the supplied series sitting at or above their
 * own trailing-window maximum (within `tolerance`).
 *
 * This is a breadth measure. Applied to gold priced in many currencies it
 * answers the question that distinguishes a gold rally from a monetary event:
 * gold rising against one currency is that currency's problem, but gold rising
 * against nearly all of them at once is the monetary system itself under strain.
 */
export function breadthAtHighs(
  seriesList: Observation[][],
  windowDays: number,
  tolerance = 0.02,
): Array<{ obsDate: IsoDate; value: number }> {
  const indexed = seriesList.map(indexSeries);
  if (indexed.length === 0) return [];

  // Evaluate on the union of dates from the longest series.
  const grid = indexed.reduce((a, b) => (b.dates.length > a.dates.length ? b : a)).dates;
  const out: Array<{ obsDate: IsoDate; value: number }> = [];

  for (const date of grid) {
    const start = shiftDays(date, -windowDays);
    let atHigh = 0;
    let counted = 0;
    for (const s of indexed) {
      const curr = asOf(s, date);
      if (curr === null) continue;
      let max = -Infinity;
      // Window scan; series here are at most a few thousand points.
      for (let i = 0; i < s.dates.length; i++) {
        const d = s.dates[i]!;
        if (d < start) continue;
        if (d > date) break;
        if (s.values[i]! > max) max = s.values[i]!;
      }
      if (max === -Infinity) continue;
      counted++;
      if (curr >= max * (1 - tolerance)) atHigh++;
    }
    // Require a quorum so a single early series can't imply 100% breadth.
    if (counted >= Math.max(3, indexed.length * 0.5)) {
      out.push({ obsDate: date, value: (atHigh / counted) * 100 });
    }
  }
  return out;
}

function shiftDays(iso: IsoDate, n: number): IsoDate {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

function daysApart(a: IsoDate, b: IsoDate): number {
  return Math.abs((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
