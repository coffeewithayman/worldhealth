import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { IndicatorSpec, Transform } from './scoring.js';
import { PILLARS, type Pillar } from './types.js';

export interface ScoringConfig {
  pillarWeights: Partial<Record<Pillar, number>>;
  indicators: IndicatorSpec[];
}

interface RawTransform {
  kind?: string;
  lookback_years?: number;
  clamp_sd?: number;
  bands?: Array<[number, number]>;
}

interface RawIndicator {
  series?: string;
  label?: string;
  pillar?: string;
  weight?: number;
  direction?: string;
  max_age_days?: number;
  transform?: RawTransform;
}

/**
 * Load and validate the scoring configuration.
 *
 * Validation is strict and fails loudly. A typo in a pillar name or a malformed
 * band would otherwise silently drop an indicator, and a model that quietly
 * scores fewer inputs than you think is worse than one that refuses to start.
 */
export function loadScoringConfig(path: string): ScoringConfig {
  let raw: { pillar_weights?: Record<string, number>; indicators?: RawIndicator[] };
  try {
    raw = parse(readFileSync(path, 'utf8')) as typeof raw;
  } catch (err) {
    throw new Error(`Cannot read scoring config at ${path}: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error(`${path} did not parse to an object`);

  const pillarWeights: Partial<Record<Pillar, number>> = {};
  for (const [k, v] of Object.entries(raw.pillar_weights ?? {})) {
    if (!PILLARS.includes(k as Pillar)) {
      throw new Error(`Unknown pillar "${k}" in pillar_weights. Valid: ${PILLARS.join(', ')}`);
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`pillar_weights.${k} must be a non-negative number, got ${JSON.stringify(v)}`);
    }
    pillarWeights[k as Pillar] = v;
  }

  const list = raw.indicators;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${path} has no indicators`);
  }

  const seen = new Set<string>();
  const indicators: IndicatorSpec[] = list.map((r, i) => {
    const where = `indicators[${i}]${r.series ? ` (${r.series})` : ''}`;
    if (!r.series) throw new Error(`${where}: missing "series"`);
    if (seen.has(r.series)) throw new Error(`${where}: duplicate series "${r.series}"`);
    seen.add(r.series);

    if (!r.pillar || !PILLARS.includes(r.pillar as Pillar)) {
      throw new Error(`${where}: pillar must be one of ${PILLARS.join(', ')}, got "${r.pillar}"`);
    }
    if (typeof r.weight !== 'number' || !(r.weight > 0)) {
      throw new Error(`${where}: weight must be a positive number`);
    }
    if (r.direction !== 'high' && r.direction !== 'low') {
      throw new Error(`${where}: direction must be "high" or "low", got "${r.direction}"`);
    }
    if (typeof r.max_age_days !== 'number' || !(r.max_age_days > 0)) {
      throw new Error(`${where}: max_age_days must be a positive number`);
    }

    return {
      seriesId: r.series,
      label: r.label ?? r.series,
      pillar: r.pillar as Pillar,
      weight: r.weight,
      direction: r.direction,
      maxAgeDays: r.max_age_days,
      transform: parseTransform(r.transform, where),
    };
  });

  return { pillarWeights, indicators };
}

function parseTransform(t: RawTransform | undefined, where: string): Transform {
  if (!t || !t.kind) throw new Error(`${where}: missing transform.kind`);

  switch (t.kind) {
    case 'percentile':
      return { kind: 'percentile', lookbackYears: t.lookback_years ?? 25 };

    case 'zscore':
      return { kind: 'zscore', lookbackYears: t.lookback_years ?? 25, clampSd: t.clamp_sd ?? 3 };

    case 'bands': {
      const bands = t.bands;
      if (!Array.isArray(bands) || bands.length < 2) {
        throw new Error(`${where}: transform.bands needs at least 2 control points`);
      }
      for (const b of bands) {
        if (!Array.isArray(b) || b.length !== 2 || typeof b[0] !== 'number' || typeof b[1] !== 'number') {
          throw new Error(`${where}: each band must be [value, score], got ${JSON.stringify(b)}`);
        }
        if (b[1] < 0 || b[1] > 100) {
          throw new Error(`${where}: band score ${b[1]} is outside 0-100`);
        }
      }
      // Interpolation assumes ascending input values; unsorted bands would
      // silently produce wrong scores rather than an error.
      for (let i = 1; i < bands.length; i++) {
        if (bands[i]![0] <= bands[i - 1]![0]) {
          throw new Error(`${where}: bands must be sorted ascending by value (${bands[i - 1]![0]} then ${bands[i]![0]})`);
        }
      }
      return { kind: 'bands', bands };
    }

    default:
      throw new Error(`${where}: unknown transform.kind "${t.kind}" (expected percentile, zscore or bands)`);
  }
}
