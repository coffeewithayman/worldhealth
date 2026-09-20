import { MIN_PILLAR_COVERAGE } from './scoring.js';
import type { Store } from './store.js';
import type { PipelineRun, PipelineStage, SeriesHealth, SourceRun } from './types.js';

/**
 * Operational alerts.
 *
 * The dashboard's own failure mode is silence: a feed breaks, the number stops
 * moving, and the page keeps rendering yesterday's crisis as if it were today's
 * calm. Everything here exists to turn that silence into a sentence on the
 * screen with a command under it.
 *
 * Two rules give the list its shape:
 *
 * - **Every alert names the fix.** An alert the reader cannot act on is a
 *   decoration. `action` is the literal command to run or the file to edit.
 * - **Causes suppress symptoms.** A source that failed to run will also have
 *   stale series; reporting both buries the one line that explains the other.
 *
 * This is computed, never stored. Alerts are a view of current state — a stored
 * alert would need expiry, acknowledgement and reconciliation, and would still
 * disagree with the database it was derived from.
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertKind =
  | 'pipeline_never_ran'
  | 'pipeline_overdue'
  | 'pipeline_failed'
  | 'derivation_failed'
  | 'source_failed'
  | 'source_never_ran'
  | 'source_missing_key'
  | 'series_stale'
  | 'pillar_excluded';

export interface Alert {
  /** Stable across runs, so the UI can key on it and a future notifier can dedupe. */
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** One line stating what is wrong. */
  title: string;
  /** The evidence: counts, ages, the upstream error. */
  detail: string;
  /** The command to run or the change to make. Null when there is nothing to do but wait. */
  action: string | null;
  /** What the alert is about: a stage, a source id, a series id, a pillar. */
  subject: string;
  /** When the condition started, as far as we can tell. */
  since: string | null;
}

export interface ConnectorHealth {
  id: string;
  name: string;
  optional?: boolean;
  requiresKey?: string | null;
  /** Whether that key is actually present in the environment. */
  keyPresent?: boolean;
}

export interface PillarCoverage {
  pillar: string;
  coverage: number;
  missing?: string[];
}

export interface AlertInput {
  /** ISO timestamp to evaluate against. Defaults to now; tests pin it. */
  now?: string;
  pipelineRuns: PipelineRun[];
  sourceRuns: SourceRun[];
  connectors: ConnectorHealth[];
  series: Array<{ id: string; sourceId: string }>;
  health: SeriesHealth[];
  pillars?: PillarCoverage[];
}

/**
 * How long after its last run the updater is considered late, then broken.
 *
 * A daily job that missed one firing may simply have been running when we
 * looked; 36 hours means it missed one and its retry. Three days without a
 * write is not a hiccup.
 */
export const UPDATE_OVERDUE_HOURS = 36;
export const UPDATE_BROKEN_HOURS = 72;

/** Stages that write data — the ones whose absence means the dashboard is frozen. */
const WRITE_STAGES: PipelineStage[] = ['daily', 'ingest', 'backfill'];

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Failure lists recorded in `PipelineRun.detail`.
 *
 * The writer is `runStage` in the ingest package; keeping the reader defensive
 * means an older row written before a shape change degrades to "no detail"
 * rather than crashing the dashboard that reads it.
 */
export interface StageDetail {
  failed?: Array<{ id: string; error?: string | null }>;
  [k: string]: unknown;
}

export function failedUnits(detail: unknown): Array<{ id: string; error: string | null }> {
  if (!detail || typeof detail !== 'object') return [];
  const list = (detail as StageDetail).failed;
  if (!Array.isArray(list)) return [];
  return list
    .filter((f): f is { id: string; error?: string | null } => !!f && typeof f === 'object' && typeof f.id === 'string')
    .map((f) => ({ id: f.id, error: f.error ?? null }));
}

function hoursSince(iso: string, now: string): number {
  const then = Date.parse(iso);
  const at = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(at)) return 0;
  return (at - then) / 3_600_000;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Truncate an upstream error to something that fits on a dashboard row. */
function short(msg: string | null | undefined, max = 180): string {
  if (!msg) return '';
  const flat = msg.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function computeAlerts(input: AlertInput): Alert[] {
  const now = input.now ?? new Date().toISOString();
  const alerts: Alert[] = [];

  /* ------------------------------------------------------------- pipeline */

  // A dry run records itself as `skipped` — it fetched and parsed but wrote
  // nothing, so counting it as an update would let `--dry-run` silence the
  // alert that says the data is frozen.
  const writeRuns = input.pipelineRuns.filter((r) => WRITE_STAGES.includes(r.stage) && r.status !== 'skipped');
  const lastWrite = writeRuns
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  if (!lastWrite) {
    alerts.push({
      id: 'pipeline_never_ran:update',
      kind: 'pipeline_never_ran',
      severity: 'critical',
      subject: 'update',
      title: 'The data pipeline has never run',
      detail: 'No ingest, backfill or daily run has ever been recorded, so every number on this page is either absent or from a manual load.',
      action: 'npm run migrate && npm run backfill && npm run daily',
      since: null,
    });
  } else {
    const age = hoursSince(lastWrite.startedAt, now);
    if (age >= UPDATE_OVERDUE_HOURS) {
      const broken = age >= UPDATE_BROKEN_HOURS;
      alerts.push({
        id: 'pipeline_overdue:update',
        kind: 'pipeline_overdue',
        severity: broken ? 'critical' : 'warning',
        subject: lastWrite.stage,
        title: `No update in ${Math.floor(age / 24)}d ${Math.floor(age % 24)}h`,
        detail: `The last ${lastWrite.stage} run started ${lastWrite.startedAt}. Readings are frozen as of that run, however current the page looks.`,
        action: 'npm run daily  # and check the scheduler that should have run it',
        since: lastWrite.startedAt,
      });
    }
  }

  for (const run of input.pipelineRuns) {
    if (run.status === 'error') {
      alerts.push({
        id: `pipeline_failed:${run.stage}`,
        kind: 'pipeline_failed',
        severity: 'critical',
        subject: run.stage,
        title: `The ${run.stage} stage failed`,
        detail: short(run.error) || 'The stage threw without an error message.',
        action: `npm run ${run.stage === 'daily' ? 'daily' : run.stage}`,
        since: run.startedAt,
      });
    }

    // A derivation that stopped computing is the quietest failure in the
    // system: the `d.` series simply stops existing and every indicator
    // reading it drops out of the score with no visible mark on the number.
    if (run.stage === 'derive' || run.stage === 'daily') {
      const failed = failedUnits(run.detail);
      if (failed.length > 0) {
        alerts.push({
          id: `derivation_failed:${run.stage}`,
          kind: 'derivation_failed',
          severity: 'critical',
          subject: run.stage,
          title: `${plural(failed.length, 'derived series')} failed to compute`,
          detail: failed.map((f) => `${f.id}${f.error ? `: ${short(f.error, 90)}` : ''}`).join(' · '),
          action: `node packages/ingest/dist/cli.js derive`,
          since: run.startedAt,
        });
      }
    }
  }

  /* -------------------------------------------------------------- sources */

  const runBySource = new Map(input.sourceRuns.map((r) => [r.sourceId, r]));
  const seriesBySource = new Map<string, string[]>();
  for (const s of input.series) {
    const list = seriesBySource.get(s.sourceId) ?? [];
    list.push(s.id);
    seriesBySource.set(s.sourceId, list);
  }
  const healthById = new Map(input.health.map((h) => [h.seriesId, h]));
  /** Sources whose own failure already explains any staleness underneath it. */
  const explained = new Set<string>();

  for (const conn of input.connectors) {
    const run = runBySource.get(conn.id);

    if (!run) {
      // Never having run is only worth saying once the rest of the pipeline is
      // alive — on a fresh checkout every source is unrun and the pipeline
      // alert above already says so.
      if (lastWrite) {
        explained.add(conn.id);
        alerts.push({
          id: `source_never_ran:${conn.id}`,
          kind: 'source_never_ran',
          severity: conn.optional ? 'info' : 'warning',
          subject: conn.id,
          title: `${conn.name} has never run`,
          detail: 'The pipeline has run since, so this source was added later or is being skipped.',
          action: `npm run ingest -- --only ${conn.id}`,
          since: null,
        });
      }
      continue;
    }

    if (run.status === 'error') {
      explained.add(conn.id);
      alerts.push({
        id: `source_failed:${conn.id}`,
        kind: 'source_failed',
        // An optional source is expected to be flaky — unofficial endpoints and
        // scraped pages. Treating that as critical trains the reader to ignore
        // the colour, which costs them the one time it is real.
        severity: conn.optional ? 'warning' : 'critical',
        subject: conn.id,
        title: `${conn.name} failed on its last run`,
        detail: short(run.error) || 'No error message was recorded.',
        action: `npm run doctor -- --only ${conn.id}`,
        since: run.startedAt,
      });
      continue;
    }

    if (run.status === 'skipped' && conn.requiresKey && conn.keyPresent === false) {
      explained.add(conn.id);
      alerts.push({
        id: `source_missing_key:${conn.id}`,
        kind: 'source_missing_key',
        severity: 'info',
        subject: conn.id,
        title: `${conn.name} is disabled — no ${conn.requiresKey}`,
        detail: `${plural(seriesBySource.get(conn.id)?.length ?? 0, 'series')} from this source are unavailable until the key is set.`,
        action: `echo "${conn.requiresKey}=..." >> .env.local`,
        since: run.startedAt,
      });
    }
  }

  /* ---------------------------------------------------------- stale series */

  const staleBySource = new Map<string, SeriesHealth[]>();
  for (const [sourceId, ids] of seriesBySource) {
    if (explained.has(sourceId)) continue;
    const stale = ids.map((id) => healthById.get(id)).filter((h): h is SeriesHealth => !!h && h.stale);
    if (stale.length > 0) staleBySource.set(sourceId, stale);
  }

  const connById = new Map(input.connectors.map((c) => [c.id, c]));
  for (const [sourceId, stale] of [...staleBySource].sort((a, b) => b[1].length - a[1].length)) {
    const conn = connById.get(sourceId);
    const total = seriesBySource.get(sourceId)?.length ?? stale.length;
    const allStale = stale.length === total;
    const worst = stale.reduce((a, h) => ((h.ageDays ?? Infinity) > (a.ageDays ?? Infinity) ? h : a), stale[0]!);
    const derived = sourceId === 'derived';
    alerts.push({
      id: `series_stale:${sourceId}`,
      kind: 'series_stale',
      // Every series from one source past its budget means the feed is dead
      // even though its last run reported success — the shape of an upstream
      // that quietly stopped publishing, or of a parser that stopped matching.
      severity: allStale && !conn?.optional ? 'critical' : 'warning',
      subject: sourceId,
      title: `${conn?.name ?? sourceId}: ${stale.length} of ${total} series past their refresh budget`,
      detail: `Oldest is ${worst.seriesId}, ${worst.lastObsDate ? `last observation ${worst.lastObsDate} (${worst.ageDays}d, budget ${worst.stalenessBudgetDays}d)` : 'never loaded'}.`
        + (allStale ? ' The last run reported success, so the feed is returning nothing usable.' : ''),
      action: derived
        ? 'node packages/ingest/dist/cli.js derive'
        : `npm run doctor -- --only ${sourceId}`,
      since: worst.lastObsDate,
    });
  }

  /* -------------------------------------------------------------- scoring */

  for (const p of input.pillars ?? []) {
    if (p.coverage >= MIN_PILLAR_COVERAGE) continue;
    alerts.push({
      id: `pillar_excluded:${p.pillar}`,
      kind: 'pillar_excluded',
      severity: 'warning',
      subject: p.pillar,
      title: `The ${p.pillar} pillar is excluded from the composite`,
      detail: `Only ${(p.coverage * 100).toFixed(0)}% of its intended weight is available (floor is ${(MIN_PILLAR_COVERAGE * 100).toFixed(0)}%)`
        + (p.missing?.length ? `. Missing: ${p.missing.slice(0, 6).join(', ')}${p.missing.length > 6 ? ` +${p.missing.length - 6} more` : ''}` : '.'),
      action: 'npm run sources  # check which feed owns the missing series',
      since: null,
    });
  }

  return alerts.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.kind.localeCompare(b.kind)
    || a.subject.localeCompare(b.subject));
}

/**
 * Kinds that mean *this run* failed, as opposed to a condition that is simply
 * true today.
 *
 * The distinction is what a scheduler's exit code should turn on. A source
 * whose series have been stale for a month is worth a critical alert on the
 * page, but failing the nightly unit over it every night leaves a timer
 * permanently red — and a permanently red timer is one nobody looks at, which
 * costs the failure that was about to matter.
 */
export const RUN_FAILURE_KINDS: readonly AlertKind[] = [
  'pipeline_failed', 'derivation_failed', 'source_failed',
] as const;

export function hasRunFailure(alerts: Alert[]): boolean {
  return alerts.some((a) => a.severity === 'critical' && RUN_FAILURE_KINDS.includes(a.kind));
}

export interface AlertSummary {
  total: number;
  critical: number;
  warning: number;
  info: number;
  /** Worst severity present, or null when everything is healthy. */
  worst: AlertSeverity | null;
}

export function summarizeAlerts(alerts: Alert[]): AlertSummary {
  const count = (s: AlertSeverity) => alerts.filter((a) => a.severity === s).length;
  const critical = count('critical');
  const warning = count('warning');
  const info = count('info');
  return {
    total: alerts.length,
    critical,
    warning,
    info,
    worst: critical ? 'critical' : warning ? 'warning' : info ? 'info' : null,
  };
}

/**
 * Read the store and compute alerts.
 *
 * The single entry point for both the API and the CLI. Assembling the input in
 * each caller would let them drift, and a dashboard that disagrees with
 * `npm run alerts` about whether something is broken is worse than either.
 */
export async function collectAlerts(
  store: Store,
  opts: { connectors: ConnectorHealth[]; pillars?: PillarCoverage[]; now?: string },
): Promise<Alert[]> {
  const [pipelineRuns, sourceRuns, health, series] = await Promise.all([
    store.getLatestPipelineRuns(),
    store.getLatestRuns(),
    store.getSeriesHealth(),
    store.listSeries(),
  ]);
  return computeAlerts({
    now: opts.now,
    pipelineRuns,
    sourceRuns,
    health,
    connectors: opts.connectors,
    series: series.map((s) => ({ id: s.id, sourceId: s.sourceId })),
    pillars: opts.pillars,
  });
}
