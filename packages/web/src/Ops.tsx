import { useEffect, useState } from 'react';
import { api, EVENT_CATEGORIES, type Dashboard, type SourceInfo, type WorldEvent } from './api';
import { SectionHead } from './components';
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
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  useEffect(() => { api.sources().then((r) => setSources(r.sources)).catch(() => setSources([])); }, []);

  const list = sources ?? [];
  const broken = list.filter((s) => s.lastRun?.status === 'error').length;

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

      {broken > 0 && (
        <div className="notice">
          <span aria-hidden="true">▲</span>
          <div><strong>{broken} source{broken > 1 ? 's' : ''} failed on the last run.</strong> The error is in the table below.</div>
        </div>
      )}

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
