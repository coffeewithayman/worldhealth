import {
  DERIVATIONS, derivationToSeriesDef, describeError, log,
  type Observation, type Store,
} from '@wd/core';

const logger = log.child('derive');

export interface DeriveOutcome {
  id: string;
  status: 'ok' | 'skipped' | 'error';
  rows: number;
  detail?: string;
}

/**
 * Compute every derived series and persist it.
 *
 * Runs in declaration order, and each derivation can read series produced by an
 * earlier one — `d.gold_breadth` depends on the per-currency gold series
 * computed immediately above it. Ordering in `DERIVATIONS` is therefore
 * meaningful, unlike the connector registry.
 */
export async function deriveAll(store: Store, since: string): Promise<DeriveOutcome[]> {
  const cache = new Map<string, Observation[]>();
  const outcomes: DeriveOutcome[] = [];

  const load = async (id: string): Promise<Observation[]> => {
    const hit = cache.get(id);
    if (hit) return hit;
    const obs = await store.getObservations(id);
    cache.set(id, obs);
    return obs;
  };

  for (const d of DERIVATIONS) {
    try {
      // Required inputs must all exist; optional ones enrich the result.
      const missing: string[] = [];
      for (const id of d.inputs) {
        const obs = await load(id);
        if (obs.length === 0) missing.push(id);
      }
      if (missing.length > 0) {
        // Warn rather than debug: a skipped derivation removes every indicator
        // built on it from the score, and the score itself says nothing about
        // having shrunk.
        logger.warn('skipped', { id: d.id, missing });
        outcomes.push({ id: d.id, status: 'skipped', rows: 0, detail: `missing input(s): ${missing.join(', ')}` });
        continue;
      }
      for (const id of d.optionalInputs ?? []) await load(id);

      const points = d.compute((id) => cache.get(id));
      const fresh = points.filter((p) => p.obsDate >= since);
      if (fresh.length === 0) {
        logger.warn('no output in window', { id: d.id, since, computed: points.length });
        outcomes.push({ id: d.id, status: 'skipped', rows: 0, detail: `no output on or after ${since}` });
        continue;
      }

      const observations: Observation[] = fresh.map((p) => ({
        seriesId: d.id, obsDate: p.obsDate, value: p.value,
      }));

      await store.upsertSeries([derivationToSeriesDef(d)]);
      const rows = await store.putObservations(observations);
      await store.markSeriesSuccess([d.id], new Date().toISOString());

      // Make the full computed history visible to later derivations, not just
      // the window we persisted this run.
      cache.set(d.id, points.map((p) => ({ seriesId: d.id, obsDate: p.obsDate, value: p.value })));
      logger.debug('computed', { id: d.id, rows, points: points.length });
      outcomes.push({ id: d.id, status: 'ok', rows });
    } catch (err) {
      // One broken derivation must not abort the rest, exactly as with
      // connectors — but unlike a connector it has no `source_runs` row, so the
      // log and the returned outcome are the only record.
      logger.error('failed', { id: d.id, err });
      outcomes.push({ id: d.id, status: 'error', rows: 0, detail: describeError(err).message });
    }
  }

  return outcomes;
}
