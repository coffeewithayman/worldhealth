import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  computeAlerts, failedUnits, hasRunFailure, summarizeAlerts,
  UPDATE_BROKEN_HOURS, UPDATE_OVERDUE_HOURS,
  type Alert, type AlertInput,
} from './alerts.js';
import type { PipelineRun, SeriesHealth, SourceRun } from './types.js';

const NOW = '2026-09-19T12:00:00.000Z';

function hoursAgo(h: number): string {
  return new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
}

function pipelineRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    stage: 'daily',
    startedAt: hoursAgo(2),
    finishedAt: hoursAgo(1.9),
    status: 'ok',
    okCount: 10,
    failCount: 0,
    rowsWritten: 500,
    error: null,
    detail: null,
    ...over,
  };
}

function sourceRun(sourceId: string, over: Partial<SourceRun> = {}): SourceRun {
  return {
    sourceId,
    startedAt: hoursAgo(2),
    finishedAt: hoursAgo(1.9),
    status: 'ok',
    rowsWritten: 40,
    eventsWritten: 0,
    error: null,
    ...over,
  };
}

function health(seriesId: string, over: Partial<SeriesHealth> = {}): SeriesHealth {
  return {
    seriesId,
    lastObsDate: '2026-09-18',
    lastSuccessAt: hoursAgo(2),
    stalenessBudgetDays: 7,
    ageDays: 1,
    stale: false,
    retired: false,
    retiredAt: null,
    ...over,
  };
}

/** A healthy world: one source, two fresh series, a daily run two hours ago. */
function healthyInput(over: Partial<AlertInput> = {}): AlertInput {
  return {
    now: NOW,
    pipelineRuns: [pipelineRun()],
    sourceRuns: [sourceRun('fred')],
    connectors: [{ id: 'fred', name: 'FRED', optional: false, requiresKey: 'FRED_API_KEY', keyPresent: true }],
    series: [{ id: 'us.m2', sourceId: 'fred' }, { id: 'us.hy_oas', sourceId: 'fred' }],
    health: [health('us.m2'), health('us.hy_oas')],
    ...over,
  };
}

const kinds = (alerts: Alert[]) => alerts.map((a) => a.kind);
const byKind = (alerts: Alert[], kind: string) => alerts.find((a) => a.kind === kind);

/* ------------------------------------------------------------- the quiet case */

test('a healthy pipeline produces no alerts at all', () => {
  // The panel has to be able to disappear. An ops view that always has
  // something in it is one the reader stops looking at.
  assert.deepEqual(computeAlerts(healthyInput()), []);
});

/* ------------------------------------------------------------------ pipeline */

test('a pipeline that has never run is critical, and drowns out nothing else', () => {
  // On a fresh checkout every source is also unrun. Listing ten "source has
  // never run" alerts under the one that explains them is noise.
  const alerts = computeAlerts(healthyInput({ pipelineRuns: [], sourceRuns: [] }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, 'pipeline_never_ran');
  assert.equal(alerts[0]!.severity, 'critical');
  assert.match(alerts[0]!.action!, /migrate/);
});

test('an update inside its budget raises nothing; past it, warning then critical', () => {
  const at = (h: number) => computeAlerts(healthyInput({
    pipelineRuns: [pipelineRun({ startedAt: hoursAgo(h), finishedAt: hoursAgo(h) })],
  }));

  assert.equal(byKind(at(UPDATE_OVERDUE_HOURS - 1), 'pipeline_overdue'), undefined);
  assert.equal(byKind(at(UPDATE_OVERDUE_HOURS + 1), 'pipeline_overdue')?.severity, 'warning');
  assert.equal(byKind(at(UPDATE_BROKEN_HOURS + 1), 'pipeline_overdue')?.severity, 'critical');
});

test('the overdue alert says how long it has been, not just that it is late', () => {
  const alerts = computeAlerts(healthyInput({
    pipelineRuns: [pipelineRun({ startedAt: hoursAgo(50), finishedAt: hoursAgo(50) })],
  }));
  const overdue = byKind(alerts, 'pipeline_overdue')!;
  assert.match(overdue.title, /2d 2h/);
  assert.match(overdue.detail, /frozen/i, 'the consequence matters more than the timestamp');
});

test('a backfill counts as an update, a score run does not', () => {
  // Scoring re-reads what is already stored. A dashboard whose scorer runs
  // nightly but whose ingest died is still frozen, and must still say so.
  const scoreOnly = computeAlerts(healthyInput({
    pipelineRuns: [pipelineRun({ stage: 'score', startedAt: hoursAgo(1), finishedAt: hoursAgo(1) })],
  }));
  assert.equal(byKind(scoreOnly, 'pipeline_never_ran')?.severity, 'critical');

  const backfilled = computeAlerts(healthyInput({
    pipelineRuns: [pipelineRun({ stage: 'backfill', startedAt: hoursAgo(1), finishedAt: hoursAgo(1) })],
  }));
  assert.equal(byKind(backfilled, 'pipeline_never_ran'), undefined);
  assert.equal(byKind(backfilled, 'pipeline_overdue'), undefined);
});

test('a dry run does not count as an update', () => {
  // `ingest --dry-run` records itself as skipped: it parsed everything and
  // wrote nothing. Counting it would let a dry run silence the alert that says
  // the data on screen is frozen.
  const alerts = computeAlerts(healthyInput({
    pipelineRuns: [pipelineRun({ status: 'skipped', rowsWritten: 0, startedAt: hoursAgo(1), finishedAt: hoursAgo(1) })],
  }));
  assert.equal(byKind(alerts, 'pipeline_never_ran')?.severity, 'critical');
});

test('a stage that threw is reported with its error and the command to retry', () => {
  const alerts = computeAlerts(healthyInput({
    pipelineRuns: [
      pipelineRun(),
      pipelineRun({ stage: 'derive', status: 'error', error: 'TypeError: cannot read length of undefined' }),
    ],
  }));
  const failed = byKind(alerts, 'pipeline_failed')!;
  assert.equal(failed.severity, 'critical');
  assert.equal(failed.subject, 'derive');
  assert.match(failed.detail, /TypeError/);
  assert.match(failed.action!, /derive/);
});

test('failed derivations are named, because a missing d.* series scores silently', () => {
  // This is the quietest failure in the system: the indicator simply drops out
  // of the pillar and the composite keeps printing a plausible number.
  const alerts = computeAlerts(healthyInput({
    pipelineRuns: [pipelineRun({
      stage: 'derive',
      status: 'partial',
      detail: { failed: [{ id: 'd.gold_breadth', error: 'no input rows' }, { id: 'd.m2_yoy' }] },
    }), pipelineRun()],
  }));
  const derived = byKind(alerts, 'derivation_failed')!;
  assert.equal(derived.severity, 'critical');
  assert.match(derived.title, /2 derived series/);
  assert.match(derived.detail, /d\.gold_breadth/);
  assert.match(derived.detail, /d\.m2_yoy/);
});

test('failedUnits tolerates detail written by an older or hand-edited row', () => {
  // The dashboard must degrade to "no detail" rather than crash on a shape it
  // does not recognise — this is read straight out of a TEXT column.
  assert.deepEqual(failedUnits(null), []);
  assert.deepEqual(failedUnits('not json'), []);
  assert.deepEqual(failedUnits({ failed: 'nope' }), []);
  assert.deepEqual(failedUnits({ failed: [{ nope: 1 }] }), []);
  assert.deepEqual(failedUnits({ failed: [{ id: 'd.x' }] }), [{ id: 'd.x', error: null }]);
});

/* ------------------------------------------------------------------- sources */

test('a failed required source is critical; a failed optional source is a warning', () => {
  const input = healthyInput({
    connectors: [
      { id: 'fred', name: 'FRED', optional: false },
      { id: 'lbma', name: 'LBMA', optional: true },
    ],
    sourceRuns: [
      sourceRun('fred', { status: 'error', error: 'HTTP 500 from api.stlouisfed.org' }),
      sourceRun('lbma', { status: 'error', error: 'HTTP 403' }),
    ],
    series: [{ id: 'us.m2', sourceId: 'fred' }, { id: 'metal.gold', sourceId: 'lbma' }],
    health: [health('us.m2'), health('metal.gold')],
  });
  const alerts = computeAlerts(input);
  const fred = alerts.find((a) => a.subject === 'fred')!;
  const lbma = alerts.find((a) => a.subject === 'lbma')!;

  assert.equal(fred.severity, 'critical');
  assert.match(fred.detail, /api\.stlouisfed\.org/, 'the upstream error is the point');
  // Optional sources are unofficial endpoints and scraped pages; treating their
  // flakiness as critical teaches the reader to ignore the colour.
  assert.equal(lbma.severity, 'warning');
});

test('a source skipped for a missing key is information, not a failure', () => {
  const alerts = computeAlerts(healthyInput({
    sourceRuns: [sourceRun('fred', { status: 'skipped', error: 'missing FRED_API_KEY' })],
    connectors: [{ id: 'fred', name: 'FRED', requiresKey: 'FRED_API_KEY', keyPresent: false }],
  }));
  const missing = byKind(alerts, 'source_missing_key')!;
  assert.equal(missing.severity, 'info');
  assert.match(missing.title, /FRED_API_KEY/);
  assert.match(missing.action!, /\.env\.local/);
});

test('a key that is present is never reported as missing', () => {
  // The skipped status can outlive the missing key: the run row is from before
  // the key was added, and reporting it again sends the reader to fix nothing.
  const alerts = computeAlerts(healthyInput({
    sourceRuns: [sourceRun('fred', { status: 'skipped', error: 'missing FRED_API_KEY' })],
    connectors: [{ id: 'fred', name: 'FRED', requiresKey: 'FRED_API_KEY', keyPresent: true }],
  }));
  assert.equal(byKind(alerts, 'source_missing_key'), undefined);
});

/* ------------------------------------------------------------- stale series */

test('stale series are grouped per source rather than listed one by one', () => {
  const stale = (id: string, age: number) => health(id, { stale: true, ageDays: age, lastObsDate: '2026-01-01' });
  const alerts = computeAlerts(healthyInput({
    series: [
      { id: 'us.m2', sourceId: 'fred' }, { id: 'us.hy_oas', sourceId: 'fred' },
      { id: 'us.sahm_rule', sourceId: 'fred' },
    ],
    health: [stale('us.m2', 200), stale('us.hy_oas', 30), health('us.sahm_rule')],
  }));

  const group = byKind(alerts, 'series_stale')!;
  assert.equal(alerts.filter((a) => a.kind === 'series_stale').length, 1, 'one alert per source, not per series');
  assert.match(group.title, /2 of 3/);
  assert.match(group.detail, /us\.m2/, 'names the worst offender so it can be checked directly');
});

test('a retired series never raises a stale alert', () => {
  // `us.nonperforming_loans` ended in 2020 when FRED discontinued it. Before
  // retirement it raised a warning every day whose age grew by one every day
  // and whose named fix — re-run the source — could not possibly work.
  const alerts = computeAlerts(healthyInput({
    series: [{ id: 'us.m2', sourceId: 'fred' }, { id: 'us.nonperforming_loans', sourceId: 'fred' }],
    health: [
      health('us.m2'),
      health('us.nonperforming_loans', { stale: true, retired: true, retiredAt: '2020-07-01', ageDays: 2272 }),
    ],
  }));
  assert.equal(byKind(alerts, 'series_stale'), undefined);
});

test('a retired series is out of the denominator, so "all stale" still means dead', () => {
  // Otherwise one genuinely broken series alongside one retired one reads as
  // "1 of 2", which downgrades the alert that should say the feed is dead.
  const alerts = computeAlerts(healthyInput({
    series: [{ id: 'us.m2', sourceId: 'fred' }, { id: 'us.nonperforming_loans', sourceId: 'fred' }],
    health: [
      health('us.m2', { stale: true, ageDays: 90 }),
      health('us.nonperforming_loans', { stale: false, retired: true, retiredAt: '2020-07-01', ageDays: 2272 }),
    ],
  }));
  const group = byKind(alerts, 'series_stale')!;
  assert.match(group.title, /1 of 1/);
  assert.equal(group.severity, 'critical');
});

test('every series of a working source being stale is critical, not a warning', () => {
  // The run says "ok" and the data says nothing has arrived: an upstream that
  // stopped publishing, or a parser that silently stopped matching.
  const alerts = computeAlerts(healthyInput({
    health: [health('us.m2', { stale: true, ageDays: 90 }), health('us.hy_oas', { stale: true, ageDays: 90 })],
  }));
  const group = byKind(alerts, 'series_stale')!;
  assert.equal(group.severity, 'critical');
  assert.match(group.detail, /reported success/);
});

test('a failed source does not also raise a stale alert for its own series', () => {
  // Cause over symptom: the failure explains the staleness, and printing both
  // buries the line that says what to fix.
  const alerts = computeAlerts(healthyInput({
    sourceRuns: [sourceRun('fred', { status: 'error', error: 'connect ETIMEDOUT' })],
    health: [health('us.m2', { stale: true, ageDays: 90 }), health('us.hy_oas', { stale: true, ageDays: 90 })],
  }));
  assert.deepEqual(kinds(alerts), ['source_failed']);
});

test('stale derived series point at derive, not at a connector that does not exist', () => {
  const alerts = computeAlerts(healthyInput({
    series: [{ id: 'd.m2_yoy', sourceId: 'derived' }],
    health: [health('d.m2_yoy', { stale: true, ageDays: 120 })],
  }));
  const group = byKind(alerts, 'series_stale')!;
  assert.match(group.action!, /derive/);
  assert.doesNotMatch(group.action!, /--only derived/);
});

/* ---------------------------------------------------------------- scoring */

test('a pillar dropped from the composite for low coverage is reported', () => {
  const alerts = computeAlerts(healthyInput({
    pillars: [
      { pillar: 'credit', coverage: 0.2, missing: ['us.repo', 'us.swaps'] },
      { pillar: 'monetary', coverage: 0.9 },
    ],
  }));
  const excluded = alerts.filter((a) => a.kind === 'pillar_excluded');
  assert.equal(excluded.length, 1, 'only the pillar below the floor');
  assert.equal(excluded[0]!.subject, 'credit');
  assert.match(excluded[0]!.detail, /us\.repo/);
});

/* ------------------------------------------------------------- list shape */

test('alerts are ordered worst first', () => {
  const alerts = computeAlerts(healthyInput({
    pipelineRuns: [pipelineRun({ stage: 'ingest', status: 'error', error: 'boom' }), pipelineRun()],
    sourceRuns: [sourceRun('fred'), sourceRun('lbma', { status: 'skipped', error: 'missing LBMA_KEY' })],
    connectors: [
      { id: 'fred', name: 'FRED' },
      { id: 'lbma', name: 'LBMA', requiresKey: 'LBMA_KEY', keyPresent: false },
    ],
    series: [{ id: 'us.m2', sourceId: 'fred' }],
    health: [health('us.m2', { stale: true, ageDays: 90 })],
  }));
  const rank = { critical: 0, warning: 1, info: 2 };
  const seq = alerts.map((a) => rank[a.severity]);
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b), `out of order: ${alerts.map((a) => a.severity).join()}`);
});

test('every alert carries a unique id and something to do about it', () => {
  const alerts = computeAlerts(healthyInput({
    pipelineRuns: [
      pipelineRun({ startedAt: hoursAgo(90), finishedAt: hoursAgo(90) }),
      pipelineRun({ stage: 'derive', status: 'error', error: 'boom' }),
    ],
    sourceRuns: [sourceRun('fred', { status: 'error', error: 'HTTP 500' })],
    pillars: [{ pillar: 'credit', coverage: 0.1 }],
  }));
  const ids = alerts.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique — the UI keys on them');
  for (const a of alerts) {
    assert.ok(a.title.length > 0 && a.detail.length > 0, `${a.id} is missing its text`);
    assert.ok(a.action && a.action.length > 0, `${a.id} tells the reader nothing to do`);
  }
});

test('long-standing staleness is critical on the page but does not fail the run', () => {
  // A nightly unit that goes red over an upstream nobody controls is a unit
  // nobody looks at, which costs the failure that was about to matter.
  const stale = computeAlerts(healthyInput({
    health: [health('us.m2', { stale: true, ageDays: 90 }), health('us.hy_oas', { stale: true, ageDays: 90 })],
  }));
  assert.equal(summarizeAlerts(stale).critical, 1, 'still critical on the dashboard');
  assert.equal(hasRunFailure(stale), false, 'but not a failure of tonight\'s run');

  const crashed = computeAlerts(healthyInput({
    pipelineRuns: [pipelineRun(), pipelineRun({ stage: 'derive', status: 'error', error: 'boom' })],
  }));
  assert.equal(hasRunFailure(crashed), true);
});

test('summarizeAlerts reports the worst severity present', () => {
  assert.equal(summarizeAlerts([]).worst, null);
  const alerts = computeAlerts(healthyInput({
    sourceRuns: [sourceRun('fred', { status: 'error', error: 'x' })],
  }));
  const sum = summarizeAlerts(alerts);
  assert.equal(sum.worst, 'critical');
  assert.equal(sum.total, sum.critical + sum.warning + sum.info);
});
