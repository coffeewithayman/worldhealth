import {
  describeError, log, type PipelineRun, type PipelineStage, type RunStatus, type Store,
} from '@wd/core';

/**
 * What a stage reports about itself when it finishes normally.
 *
 * `failed` is the contract the alert engine reads (`failedUnits` in
 * `core/src/alerts.ts`): a list of the units — connectors, derivations — that
 * did not succeed. Everything else in `detail` is free-form context for the
 * Sources tab and for whoever is reading the log at 6am.
 */
export interface StageResult {
  okCount?: number;
  failCount?: number;
  rowsWritten?: number;
  failed?: Array<{ id: string; error?: string | null }>;
  /** Anything else worth persisting alongside the run. */
  detail?: Record<string, unknown>;
  /** Overrides the status inferred from `failed`. */
  status?: RunStatus;
}

/**
 * Run one pipeline stage, recording the attempt whether or not it survives.
 *
 * This is the mechanism that makes a broken update visible. Three cases, and
 * all three end with a row in `pipeline_runs`:
 *
 * - the stage succeeds → `ok`, with its counts
 * - some units fail → `partial`, with their ids and errors
 * - the stage itself throws → `error`, with the message, and the throw is
 *   re-raised so the exit code is still non-zero for the scheduler
 *
 * The third case is the one that motivates the whole file: before it, a crash
 * in `derive` left no trace anywhere the dashboard could read, so the page kept
 * serving the last good score with nothing to say that scoring had stopped.
 */
export async function runStage<T>(
  store: Store,
  stage: PipelineStage,
  fn: () => Promise<{ result: T } & StageResult>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const logger = log.child('stage', { stage });
  logger.info('started');

  const record = async (run: Omit<PipelineRun, 'stage' | 'startedAt' | 'finishedAt'>): Promise<void> => {
    try {
      await store.recordPipelineRun({
        stage,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...run,
      });
    } catch (err) {
      // Failing to record a failure must not replace it with a different one:
      // the original error is what the operator needs.
      logger.error('could not record the run', { err });
    }
  };

  try {
    const out = await fn();
    const failed = out.failed ?? [];
    const status: RunStatus = out.status ?? (failed.length > 0 ? 'partial' : 'ok');
    await record({
      status,
      okCount: out.okCount ?? 0,
      failCount: out.failCount ?? failed.length,
      rowsWritten: out.rowsWritten ?? 0,
      error: failed.length > 0 ? `${failed.length} unit(s) failed: ${failed.map((f) => f.id).join(', ')}` : null,
      detail: { ...out.detail, failed },
    });
    logger[status === 'ok' ? 'info' : 'warn']('finished', {
      status, ok: out.okCount ?? 0, failed: failed.length, rows: out.rowsWritten ?? 0, ms: Date.now() - t0,
    });
    return out.result;
  } catch (err) {
    const e = describeError(err);
    await record({
      status: 'error',
      okCount: 0,
      failCount: 0,
      rowsWritten: 0,
      error: `${e.name}: ${e.message}`,
      detail: { failed: [{ id: stage, error: e.message }] },
    });
    logger.error('stage threw', { err, ms: Date.now() - t0 });
    throw err;
  }
}
