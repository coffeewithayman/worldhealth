import { addYears, log, todayIso, type Connector, type ResponseCache, type Store } from '@wd/core';
import { runConnector, type RunOutcome } from './runner.js';

/** How far back a backfill reaches. Percentile transforms need decades. */
export const BACKFILL_YEARS = 25;

export function backfillSince(): string {
  return addYears(todayIso(), -BACKFILL_YEARS);
}

/**
 * Connector series that have never had their deep history loaded, grouped by
 * connector.
 *
 * Read from what ingest has already written: connectors declare their series
 * at run time, so the `series` table after an ingest is the only complete
 * catalogue there is. Retired series are left out (they are never fetched),
 * as are series of sources not in `connectors` — `d.*` derived series, and
 * anything from a connector since removed.
 */
export async function pendingBackfills(
  store: Store,
  connectors: Connector[],
): Promise<Map<string, string[]>> {
  const known = new Set(connectors.map((c) => c.id));
  const done = await store.getBackfilledSeries();
  const pending = new Map<string, string[]>();
  for (const s of await store.listSeries()) {
    if (s.retiredAt || done.has(s.id) || !known.has(s.sourceId)) continue;
    const list = pending.get(s.sourceId) ?? [];
    list.push(s.id);
    pending.set(s.sourceId, list);
  }
  return pending;
}

/** Mark whatever a successful backfill run wrote as done. A failed run marks nothing, so it retries tomorrow. */
export async function recordBackfill(store: Store, outcome: RunOutcome, since: string): Promise<void> {
  if (outcome.status !== 'ok' && outcome.status !== 'partial') return;
  await store.markBackfilled(outcome.seriesIds ?? [], new Date().toISOString(), since);
}

/**
 * Backfill every pending series — the step that makes a new source a code-only
 * change. Adding a connector or a catalogue entry and merging is the whole
 * procedure: the next `daily` ingests its recent window, sees series with no
 * backfill record, and loads their history here.
 *
 * Sources that fetch per series only fetch the pending ones (`seriesIds`);
 * the rest refetch their full response, which is one request.
 */
export async function runPendingBackfills(
  store: Store,
  connectors: Connector[],
  opts: { cache?: ResponseCache; concurrency?: number; onResult?: (o: RunOutcome) => void } = {},
): Promise<{ outcomes: RunOutcome[]; pendingSeries: number }> {
  const pending = await pendingBackfills(store, connectors);
  const pendingSeries = [...pending.values()].reduce((a, ids) => a + ids.length, 0);
  if (pending.size === 0) return { outcomes: [], pendingSeries: 0 };

  const since = backfillSince();
  log.info('backfilling new series', {
    sources: [...pending.keys()], series: pendingSeries, since,
  });
  const queue = connectors.filter((c) => pending.has(c.id));
  const outcomes: RunOutcome[] = [];
  const worker = async (): Promise<void> => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const outcome = await runConnector(c, store, {
        since, cache: opts.cache, seriesIds: new Set(pending.get(c.id)),
      });
      await recordBackfill(store, outcome, since);
      outcomes.push(outcome);
      opts.onResult?.(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 2, queue.length) }, worker));
  return { outcomes: outcomes.sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1)), pendingSeries };
}
