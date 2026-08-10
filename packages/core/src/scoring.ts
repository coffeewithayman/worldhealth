import { asOf, indexSeries } from './series-math.js';
import { interpolateBands, percentileRank, zScoreToScore } from './stats.js';
import { PILLARS, type IsoDate, type Observation, type Pillar } from './types.js';

export type Transform =
  | { kind: 'percentile'; lookbackYears?: number }
  | { kind: 'zscore'; lookbackYears?: number; clampSd?: number }
  | { kind: 'bands'; bands: Array<[number, number]> };

export interface IndicatorSpec {
  seriesId: string;
  label: string;
  pillar: Pillar;
  weight: number;
  /**
   * Which end of the distribution is stressful. Ignored for `bands`, where the
   * control points already encode direction.
   */
  direction: 'high' | 'low';
  transform: Transform;
  /** How stale the underlying data may be before this indicator is dropped from scoring. */
  maxAgeDays: number;
}

export interface IndicatorScore {
  seriesId: string;
  label: string;
  pillar: Pillar;
  weight: number;
  score: number;
  rawValue: number;
  obsDate: IsoDate;
  ageDays: number;
  transform: string;
  /** Human-readable arithmetic, shown in the UI so the score is never a black box. */
  explanation: string;
}

export interface PillarScore {
  pillar: Pillar;
  score: number;
  /** Share of intended weight actually available. Low coverage means low confidence. */
  coverage: number;
  indicators: IndicatorScore[];
  missing: string[];
}

export interface CompositeScore {
  scoreDate: IsoDate;
  score: number;
  regime: string;
  pillarsElevated: number;
  pillars: PillarScore[];
  coverage: number;
}

export type SeriesData = Map<string, Observation[]>;

const MS_DAY = 86_400_000;

function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_DAY);
}

function shiftYears(iso: IsoDate, years: number): IsoDate {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

/**
 * Score one indicator as of `asOfDate`.
 *
 * Only observations at or before `asOfDate` are considered — for both the
 * current value and the historical distribution it is ranked against. This
 * point-in-time discipline is what makes the golden-fixture backtests
 * meaningful: replaying 2008 must not let the model peek at 2009.
 */
export function scoreIndicator(
  spec: IndicatorSpec,
  data: SeriesData,
  asOfDate: IsoDate,
): IndicatorScore | { missing: string; reason: string } {
  const all = data.get(spec.seriesId);
  if (!all || all.length === 0) {
    return { missing: spec.seriesId, reason: 'no data' };
  }

  const upto = all.filter((o) => o.obsDate <= asOfDate);
  if (upto.length === 0) return { missing: spec.seriesId, reason: `no data on or before ${asOfDate}` };

  const idx = indexSeries(upto);
  const obsDate = idx.dates.at(-1)!;
  const rawValue = idx.values.at(-1)!;
  const ageDays = daysBetween(obsDate, asOfDate);
  if (ageDays > spec.maxAgeDays) {
    return { missing: spec.seriesId, reason: `stale: ${ageDays}d old, budget ${spec.maxAgeDays}d` };
  }

  let score: number;
  let explanation: string;
  let transformLabel: string;

  switch (spec.transform.kind) {
    case 'percentile': {
      const years = spec.transform.lookbackYears ?? 25;
      const from = shiftYears(asOfDate, -years);
      const history = idx.dates
        .map((d, i) => ({ d, v: idx.values[i]! }))
        .filter((p) => p.d >= from)
        .map((p) => p.v);
      if (history.length < 30) {
        return { missing: spec.seriesId, reason: `only ${history.length} points in ${years}y window (need 30)` };
      }
      const pct = percentileRank(history, rawValue);
      const raw = pct * 100;
      score = spec.direction === 'high' ? raw : 100 - raw;
      transformLabel = `percentile (${years}y)`;
      explanation = `${fmt(rawValue)} sits at the ${fmt(raw, 1)}th percentile of ${history.length} observations since ${from}`
        + `${spec.direction === 'low' ? ', inverted because low values are the stressful end' : ''}`;
      break;
    }

    case 'zscore': {
      const years = spec.transform.lookbackYears ?? 25;
      const clampSd = spec.transform.clampSd ?? 3;
      const from = shiftYears(asOfDate, -years);
      const history = idx.dates
        .map((d, i) => ({ d, v: idx.values[i]! }))
        .filter((p) => p.d >= from)
        .map((p) => p.v);
      if (history.length < 30) {
        return { missing: spec.seriesId, reason: `only ${history.length} points in ${years}y window (need 30)` };
      }
      const raw = zScoreToScore(history, rawValue, clampSd);
      if (!Number.isFinite(raw)) {
        return { missing: spec.seriesId, reason: 'zero variance in history' };
      }
      score = spec.direction === 'high' ? raw : 100 - raw;
      transformLabel = `z-score (${years}y, ±${clampSd}sd)`;
      explanation = `${fmt(rawValue)} maps to ${fmt(raw, 1)} on a ±${clampSd}sd scale over ${history.length} observations since ${from}`;
      break;
    }

    case 'bands': {
      score = interpolateBands(spec.transform.bands, rawValue);
      transformLabel = 'threshold bands';
      const pts = spec.transform.bands.map(([x, y]) => `${fmt(x)}→${y}`).join(', ');
      explanation = `${fmt(rawValue)} interpolated through fixed bands [${pts}]`;
      break;
    }
  }

  if (!Number.isFinite(score)) return { missing: spec.seriesId, reason: 'transform produced a non-finite score' };

  return {
    seriesId: spec.seriesId,
    label: spec.label,
    pillar: spec.pillar,
    weight: spec.weight,
    score: Math.max(0, Math.min(100, score)),
    rawValue,
    obsDate,
    ageDays,
    transform: transformLabel,
    explanation,
  };
}

/** Minimum share of a pillar's intended weight that must be present for it to count. */
export const MIN_PILLAR_COVERAGE = 0.34;

export interface CompositeOptions {
  /** Per-pillar weights in the composite. Missing entries default to 1. */
  pillarWeights?: Partial<Record<Pillar, number>>;
}

export function computeComposite(
  specs: IndicatorSpec[],
  data: SeriesData,
  asOfDate: IsoDate,
  options: CompositeOptions = {},
): CompositeScore {
  const pillars: PillarScore[] = [];

  for (const pillar of PILLARS) {
    const pillarSpecs = specs.filter((s) => s.pillar === pillar);
    if (pillarSpecs.length === 0) continue;

    const indicators: IndicatorScore[] = [];
    const missing: string[] = [];
    let weightAvailable = 0;
    const weightTotal = pillarSpecs.reduce((a, s) => a + s.weight, 0);

    for (const spec of pillarSpecs) {
      const r = scoreIndicator(spec, data, asOfDate);
      if ('missing' in r) {
        missing.push(`${spec.seriesId} (${r.reason})`);
      } else {
        indicators.push(r);
        weightAvailable += spec.weight;
      }
    }

    const coverage = weightTotal > 0 ? weightAvailable / weightTotal : 0;
    const score = weightAvailable > 0
      ? indicators.reduce((a, i) => a + i.score * i.weight, 0) / weightAvailable
      : NaN;

    pillars.push({
      pillar,
      score,
      coverage,
      indicators: indicators.sort((a, b) => b.score * b.weight - a.score * a.weight),
      missing,
    });
  }

  // A pillar assembled from a small fraction of its inputs is not a measurement,
  // so it is excluded from the composite rather than averaged in misleadingly.
  const usable = pillars.filter((p) => Number.isFinite(p.score) && p.coverage >= MIN_PILLAR_COVERAGE);
  const pw = (p: Pillar): number => options.pillarWeights?.[p] ?? 1;
  const totalW = usable.reduce((a, p) => a + pw(p.pillar), 0);
  const score = totalW > 0 ? usable.reduce((a, p) => a + p.score * pw(p.pillar), 0) / totalW : NaN;

  const pillarsElevated = usable.filter((p) => p.score >= 70).length;

  return {
    scoreDate: asOfDate,
    score,
    regime: classifyRegime(score, pillarsElevated),
    pillarsElevated,
    pillars,
    coverage: pillars.length > 0 ? usable.length / pillars.length : 0,
  };
}

/**
 * Regime label.
 *
 * Deliberately uses the count of elevated pillars alongside the composite: a
 * single blown-out pillar can drag the average up without the system being
 * broadly stressed, and breadth of stress is what distinguishes a sector
 * problem from a systemic one.
 */
export function classifyRegime(composite: number, pillarsElevated: number): string {
  if (!Number.isFinite(composite)) return 'Insufficient data';
  if (composite >= 75 || pillarsElevated >= 5) return 'Crisis';
  if (composite >= 60 || pillarsElevated >= 3) return 'Severe stress';
  if (composite >= 45 || pillarsElevated >= 2) return 'Elevated stress';
  if (composite >= 30) return 'Watchful';
  return 'Calm';
}

function fmt(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return 'n/a';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(dp)}bn`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(dp)}m`;
  return n.toFixed(dp);
}

/** Convenience for watchlist predicates: the latest value at or before a date. */
export function latestValue(data: SeriesData, seriesId: string, asOfDate: IsoDate): { value: number; date: IsoDate } | null {
  const all = data.get(seriesId);
  if (!all || all.length === 0) return null;
  const upto = all.filter((o) => o.obsDate <= asOfDate);
  if (upto.length === 0) return null;
  const idx = indexSeries(upto);
  return { value: idx.values.at(-1)!, date: idx.dates.at(-1)! };
}

/** Value as of a past date, used by watchlist rules that need a trailing comparison. */
export function valueAsOf(data: SeriesData, seriesId: string, date: IsoDate): number | null {
  const all = data.get(seriesId);
  if (!all || all.length === 0) return null;
  return asOf(indexSeries(all.filter((o) => o.obsDate <= date)), date);
}

/** Minimum of a series over a trailing window — used to detect prior deep inversion. */
export function minOver(data: SeriesData, seriesId: string, asOfDate: IsoDate, days: number): number | null {
  const all = data.get(seriesId);
  if (!all || all.length === 0) return null;
  const from = new Date(Date.parse(`${asOfDate}T00:00:00Z`) - days * MS_DAY).toISOString().slice(0, 10);
  const window = all.filter((o) => o.obsDate >= from && o.obsDate <= asOfDate);
  if (window.length === 0) return null;
  return Math.min(...window.map((o) => o.value));
}
