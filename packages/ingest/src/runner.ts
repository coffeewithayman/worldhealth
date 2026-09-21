import {
  describeError, Http, log, NullCache, todayIso,
  type Connector, type ResponseCache, type FetchCtx, type RunStatus, type Store,
} from '@wd/core';

export interface RunOptions {
  since: string;
  dryRun?: boolean;
  noCache?: boolean;
  /** Run connectors that need a missing key anyway, to see them fail explicitly. */
  force?: boolean;
  /** Where raw responses are kept. Omitted means nothing is cached. */
  cache?: ResponseCache;
  /** Passed to the connector as `FetchCtx.seriesIds`. */
  seriesIds?: ReadonlySet<string>;
}

export interface RunOutcome {
  sourceId: string;
  status: RunStatus;
  rows: number;
  events: number;
  durationMs: number;
  error?: string;
  warnings?: string[];
  /** Series the connector declared and that were written — what a backfill may mark done. */
  seriesIds?: string[];
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
  const logger = log.child('connector', { source: connector.id });

  const finish = async (
    status: RunStatus, rows: number, events: number, error?: string, warnings?: string[],
    seriesIds?: string[],
  ): Promise<RunOutcome> => {
    const durationMs = Date.now() - t0;
    if (!opts.dryRun) {
      try {
        await store.recordRun({
          sourceId: connector.id,
          startedAt,
          finishedAt: new Date().toISOString(),
          status,
          rowsWritten: rows,
          eventsWritten: events,
          error: error ?? null,
        });
      } catch (err) {
        // The Sources tab reads `source_runs`; losing the row means a failure
        // that happened leaves no mark on the dashboard at all. Say so loudly
        // rather than letting the outcome quietly not exist.
        logger.error('could not record the run', { err });
      }
    }
    return { sourceId: connector.id, status, rows, events, durationMs, error, warnings, seriesIds };
  };

  if (connector.requiresKey && !process.env[connector.requiresKey] && !opts.force) {
    logger.debug('skipped', { needs: connector.requiresKey });
    return finish('skipped', 0, 0, `missing ${connector.requiresKey}`);
  }

  logger.debug('started', { since: opts.since, dryRun: opts.dryRun === true });

  const ctx: FetchCtx = {
    since: opts.since,
    seriesIds: opts.seriesIds,
    today: todayIso(),
    env: process.env,
    // A dry run must not write anything, and the cache is a write: `doctor`
    // used to fill it while announcing "(no writes)".
    http: new Http(opts.dryRun ? new NullCache() : (opts.cache ?? new NullCache()), connector.id, {
      defaultCacheTtlHours: 12,
      userAgent: 'world-dashboard/0.1 (personal research dashboard)',
      noCache: opts.noCache,
      logger: log,
    }),
    log: (msg) => { logs.push(msg); logger.debug(msg); },
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
    if (status === 'partial') {
      logger.warn('partial', { rows, events, warnings: result.warnings?.slice(0, 5) });
    } else {
      logger.info('ok', { rows, events, series: result.series.length, ms: Date.now() - t0 });
    }
    // A connector that ran clean and returned nothing is not an error, but it
    // is the signature of an upstream that changed shape under a parser too
    // tolerant to notice. It belongs in the log even when nothing failed.
    if (status === 'ok' && rows === 0 && events === 0) {
      logger.warn('returned no observations', { series: result.series.length, since: opts.since });
    }
    return finish(status, rows, events, result.warnings?.join('; '), result.warnings, result.series.map((s) => s.id));
  } catch (err) {
    logger.error('failed', { err, ms: Date.now() - t0, notes: logs.slice(-3) });
    return finish('error', 0, 0, describeError(err).message);
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
