import { useEffect, useState } from 'react';
import {
  api, EVENT_CATEGORIES,
  type Dashboard, type PipelineRun, type SourcesResponse, type WorldEvent,
} from './api';
import { AlertPanel, SectionHead } from './components';
import { fmtDate } from './format';

/* -------------------------------------------------------------------- events */

/**
 * News event feed.
 *
 * Deliberately behind its own tab rather than on the overview. These are
 * headlines, not measurements — useful for catching a gold sale or a bond dump
 * weeks before it reaches official statistics, but they carry no verification.
 */
export function EventsView() {
  const [events, setEvents] = useState<WorldEvent[] | null>(null);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => { api.events().then((r) => setEvents(r.events)).catch(() => setEvents([])); }, []);

  if (!events) return <div className="loading">Loading…</div>;

  const categories = ['all', ...Object.keys(EVENT_CATEGORIES)];
  const shown = filter === 'all' ? events : events.filter((e) => e.category === filter);
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);

  return (
    <div className="stack">
      <div>
        <SectionHead title="Event feed" aside={`${events.length} headlines`} />
        <p className="blurb">
          Standing news queries for the events that hard statistics report too late — a central bank
          selling gold appears in IMF data months afterwards, and foreign Treasury selling reaches TIC
          with a six-week lag. Treat these as leads to verify, never as evidence.
        </p>
      </div>

      <div className="toolbar">
        <div className="seg">
          {categories.map((cat) => (
            <button key={cat} onClick={() => setFilter(cat)} aria-current={filter === cat}>
              {cat === 'all' ? `All (${events.length})` : `${EVENT_CATEGORIES[cat] ?? cat} (${counts.get(cat) ?? 0})`}
            </button>
          ))}
        </div>
      </div>

      <section className="card flush">
        {shown.length === 0 ? (
          <div className="muted small" style={{ padding: '32px 0', textAlign: 'center' }}>
            No events in this category. Run <code className="mono">npm run ingest -- --only gdelt</code> to populate the feed.
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th style={{ width: 110 }}>When</th><th style={{ width: 160 }}>Category</th><th>Headline</th></tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id}>
                    <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.ts.slice(0, 10))}</td>
                    <td><span className="badge badge-soft">{EVENT_CATEGORIES[e.category] ?? e.category}</span></td>
                    <td>
                      <a href={e.url} target="_blank" rel="noreferrer">{e.headline}</a>
                      {e.entities?.[0] && <div className="row-sub">{e.entities.join(' · ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- sources */

export function SourcesView({ dash }: { dash: Dashboard }) {
  const [data, setData] = useState<SourcesResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.sources().then(setData).catch(() => setFailed(true));
  }, []);

  const list = data?.sources ?? [];
  // Fall back to the dashboard payload's copy: this tab is where someone lands
  // when something is wrong, and it must still say what while its own request
  // is in flight or has itself failed.
  const alerts = data?.alerts ?? dash.alerts ?? [];
  const pipeline = data?.pipeline ?? dash.health.pipeline ?? [];

  return (
    <div className="stack">
      <div>
        <SectionHead
          title="Source health"
          aside={`${list.length} feeds · ${dash.health.staleSeries} stale series`}
        />
        <p className="blurb">
          Every feed, when it last ran, and how many of its series are past their refresh budget. A
          broken source shows up here rather than quietly serving stale numbers as if they were
          current — which is the failure mode that makes a dashboard worse than no dashboard.
        </p>
      </div>

      {failed && (
        <div className="notice critical">
          <span aria-hidden="true">■</span>
          <div>
            <strong>The source-health request failed.</strong> The list below is from the dashboard
            payload and may be incomplete. Check that the API is running.
          </div>
        </div>
      )}

      <AlertPanel alerts={alerts} title="Needs attention" />

      <PipelineTable runs={pipeline} lastUpdate={dash.health.lastUpdate} />

      <section className="card flush">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th className="num">Series</th>
                <th className="num">Stale</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const run = s.lastRun;
                const tone = run?.status === 'ok' ? 'var(--status-good)'
                  : run?.status === 'partial' ? 'var(--status-warning)'
                  : run?.status === 'error' ? 'var(--status-critical)'
                  : 'var(--status-unknown)';
                const icon = run?.status === 'ok' ? '●' : run?.status === 'partial' ? '▲'
                  : run?.status === 'error' ? '■' : '?';
                return (
                  <tr key={s.id}>
                    <td style={{ maxWidth: 420 }}>
                      <div className="row-name">
                        {s.homepage ? <a href={s.homepage} target="_blank" rel="noreferrer">{s.name}</a> : s.name}
                      </div>
                      <div className="row-sub mono">{s.id} · {s.cadence}</div>
                      {s.caveat && <div className="small" style={{ color: 'var(--status-serious)', marginTop: 3 }}>{s.caveat}</div>}
                      {s.requiresKey && !run?.rowsWritten && (
                        <div className="row-sub">needs <code className="mono">{s.requiresKey}</code></div>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ color: tone, fontWeight: 550 }}>
                        <span aria-hidden="true">{icon}</span> {run?.status ?? 'never run'}
                      </span>
                      {s.optional && <div className="row-sub">optional</div>}
                    </td>
                    <td className="num">{s.seriesCount}</td>
                    <td className="num" style={{ color: s.staleCount ? 'var(--status-serious)' : undefined }}>{s.staleCount}</td>
                    <td className="small muted">
                      {run ? new Date(run.startedAt).toLocaleString() : '—'}
                      {run?.error && <div style={{ color: 'var(--status-serious)', marginTop: 3 }}>{run.error.slice(0, 160)}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {dash.health.stale.length > 0 && (
        <section className="card flush">
          <div className="card-pad" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="card-title" style={{ margin: 0 }}>Stale series ({dash.health.staleSeries})</div>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Series</th><th className="num">Last observation</th><th className="num">Age</th><th className="num">Budget</th></tr>
              </thead>
              <tbody>
                {dash.health.stale.map((h) => (
                  <tr key={h.seriesId}>
                    <td className="mono small">{h.seriesId}</td>
                    <td className="num">{h.lastObsDate ?? 'never'}</td>
                    <td className="num" style={{ color: 'var(--status-serious)' }}>{h.ageDays ?? '—'}d</td>
                    <td className="num muted">{h.stalenessBudgetDays}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ pipeline */

const STAGE_BLURB: Record<PipelineRun['stage'], string> = {
  daily: 'the scheduler entrypoint — ingest, then derive, then score',
  ingest: 'fetch from every connector',
  backfill: 'deep history load',
  derive: 'compute the d.* analysis series',
  score: 'indicators → pillars → composite',
};

/**
 * The pipeline's own health, which no per-source view can report.
 *
 * A scheduler that stopped firing leaves every source row exactly as green as
 * it was on the last day it ran. This table is the only place that difference
 * is visible, so it sits above the source list rather than below it.
 */
function PipelineTable({ runs, lastUpdate }: { runs: PipelineRun[]; lastUpdate: PipelineRun | null }) {
  const latest = new Map<string, PipelineRun>();
  for (const r of runs) if (!latest.has(r.stage)) latest.set(r.stage, r);
  const rows = [...latest.values()];

  return (
    <section className="card flush">
      <div className="alerts-head">
        <span className="card-title" style={{ margin: 0 }}>Pipeline</span>
        <span className="muted small">
          {lastUpdate ? `last update ${new Date(lastUpdate.startedAt).toLocaleString()}` : 'never run'}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="card-pad muted small">
          No run has ever been recorded. Run <code className="mono">npm run daily</code> to populate
          the dashboard, then schedule it.
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Status</th>
                <th className="num">Ok</th>
                <th className="num">Failed</th>
                <th className="num">Rows</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tone = r.status === 'ok' ? 'var(--status-good)'
                  : r.status === 'partial' ? 'var(--status-warning)'
                  : r.status === 'error' ? 'var(--status-critical)'
                  : 'var(--status-unknown)';
                const icon = r.status === 'ok' ? '●' : r.status === 'partial' ? '▲' : r.status === 'error' ? '■' : '·';
                const seconds = Math.max(0, (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000);
                return (
                  <tr key={r.stage}>
                    <td>
                      <div className="row-name mono">{r.stage}</div>
                      <div className="row-sub">{STAGE_BLURB[r.stage]}</div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ color: tone, fontWeight: 550 }}>
                        <span aria-hidden="true">{icon}</span> {r.status}
                      </span>
                      {r.error && (
                        <div className="small" style={{ color: 'var(--status-serious)', marginTop: 3, maxWidth: 420 }}>
                          {r.error.slice(0, 200)}
                        </div>
                      )}
                    </td>
                    <td className="num">{r.okCount}</td>
                    <td className="num" style={{ color: r.failCount ? 'var(--status-critical)' : undefined }}>{r.failCount}</td>
                    <td className="num">{r.rowsWritten.toLocaleString()}</td>
                    <td className="small muted" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(r.startedAt).toLocaleString()}
                      <div className="row-sub">{seconds < 90 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
