import {
  Http, todayIso, type Connector, type FetchCtx, type RunStatus, type Store,
} from '@wd/core';

export interface RunOptions {
  since: string;
  dryRun?: boolean;
  noCache?: boolean;
  /** Run connectors that need a missing key anyway, to see them fail explicitly. */
  force?: boolean;
}

export interface RunOutcome {
  sourceId: string;
  status: RunStatus;
  rows: number;
  events: number;
  durationMs: number;
  error?: string;
  warnings?: string[];
}

/**
 * Execute one connector, capturing failure rather than propagating it.
 *
 * A dashboard aggregating ~40 independent sources must never let one broken
 * feed abort the other 39. Every outcome — including failure — is written to
 * `source_runs`, which is what the UI's source-health page reads.
 */
export async function runConnector(
  connector: Connector,
  store: Store,
  opts: RunOptions,
): Promise<RunOutcome> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const logs: string[] = [];

  const finish = async (
    status: RunStatus, rows: number, events: number, error?: string, warnings?: string[],
  ): Promise<RunOutcome> => {
    const durationMs = Date.now() - t0;
    if (!opts.dryRun) {
      await store.recordRun({
        sourceId: connector.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        rowsWritten: rows,
        eventsWritten: events,
        error: error ?? null,
      });
    }
    return { sourceId: connector.id, status, rows, events, durationMs, error, warnings };
  };

  if (connector.requiresKey && !process.env[connector.requiresKey] && !opts.force) {
    return finish('skipped', 0, 0, `missing ${connector.requiresKey}`);
  }

  const ctx: FetchCtx = {
    since: opts.since,
    today: todayIso(),
    env: process.env,
    http: new Http(store, connector.id, {
      defaultCacheTtlHours: 12,
      userAgent: 'world-dashboard/0.1 (personal research dashboard)',
      noCache: opts.noCache,
    }),
    log: (msg) => { logs.push(msg); },
  };

  try {
    const result = await connector.run(ctx);

    if (opts.dryRun) {
      return finish('ok', result.observations.length, result.events?.length ?? 0, undefined, result.warnings);
    }

    await store.upsertSeries(result.series);
    const rows = await store.putObservations(result.observations);
    const events = result.events?.length ? await store.putEvents(result.events) : 0;
    await store.markSeriesSuccess(result.series.map((s) => s.id), new Date().toISOString());

    const status: RunStatus = result.warnings?.length ? 'partial' : 'ok';
    return finish(status, rows, events, result.warnings?.join('; '), result.warnings);
  } catch (err) {
    return finish('error', 0, 0, (err as Error).message);
  }
}

/**
 * Run connectors with bounded concurrency.
 *
 * Sequential would take minutes; unbounded would trip per-IP rate limits on
 * the several sources that share infrastructure. Four is comfortably inside
 * every free tier used here.
 */
export async function runAll(
  connectors: Connector[],
  store: Store,
  opts: RunOptions,
  concurrency = 4,
  onResult?: (o: RunOutcome) => void,
): Promise<RunOutcome[]> {
  const queue = [...connectors];
  const results: RunOutcome[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const outcome = await runConnector(c, store, opts);
      results.push(outcome);
      onResult?.(outcome);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, connectors.length) }, worker));
  return results.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}
