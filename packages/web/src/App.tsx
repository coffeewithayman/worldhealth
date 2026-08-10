import { useCallback, useEffect, useState } from 'react';
import { api, type Dashboard, type Markets } from './api';
import { PillarView, SeriesView } from './Detail';
import { fmtDate } from './format';
import { MarketsView } from './Markets';
import { EventsView, SourcesView } from './Ops';
import { Overview } from './Overview';

type View =
  | { name: 'overview' }
  | { name: 'markets'; group?: string }
  | { name: 'pillar'; pillar: string }
  | { name: 'series'; id: string }
  | { name: 'events' }
  | { name: 'sources' };

/**
 * Views live in the URL hash.
 *
 * A dashboard whose panels cannot be linked to is a dashboard nobody cites.
 * The hash rather than the History API keeps this a static bundle that works
 * from any path, including the `file://` case and the API's own static mount.
 */
function parseHash(hash: string): View {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'markets': return { name: 'markets', group: parts[1] };
    case 'pillar': return parts[1] ? { name: 'pillar', pillar: parts[1] } : { name: 'overview' };
    case 'series': return parts[1] ? { name: 'series', id: parts[1] } : { name: 'overview' };
    case 'events': return { name: 'events' };
    case 'sources': return { name: 'sources' };
    default: return { name: 'overview' };
  }
}

function toHash(v: View): string {
  switch (v.name) {
    case 'overview': return '#/';
    case 'markets': return v.group ? `#/markets/${v.group}` : '#/markets';
    case 'pillar': return `#/pillar/${encodeURIComponent(v.pillar)}`;
    case 'series': return `#/series/${encodeURIComponent(v.id)}`;
    default: return `#/${v.name}`;
  }
}

const TABS: Array<{ id: View['name']; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'markets', label: 'Markets' },
  { id: 'events', label: 'Events' },
  { id: 'sources', label: 'Sources' },
];

export default function App() {
  const [view, setViewState] = useState<View>(() => parseHash(window.location.hash));
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [markets, setMarkets] = useState<Markets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(
    () => (localStorage.getItem('wd-theme') as 'light' | 'dark' | null) ?? null,
  );

  const setView = useCallback((next: View) => {
    setViewState(next);
    const target = toHash(next);
    if (window.location.hash !== target) window.location.hash = target;
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onHash = () => setViewState(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api.dashboard().then(setDash).catch((e: Error) => setError(e.message));
    // The markets board is a second request rather than part of the dashboard
    // payload: the overview renders without it, so a slow board never delays
    // the number the page exists to show.
    api.markets().then(setMarkets).catch(() => setMarkets(null));
  }, []);

  useEffect(() => {
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('wd-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem('wd-theme');
    }
  }, [theme]);

  const openSeries = useCallback((id: string) => setView({ name: 'series', id }), [setView]);
  const openPillar = useCallback((pillar: string) => setView({ name: 'pillar', pillar }), [setView]);

  if (error) {
    return (
      <div className="app">
        <div className="notice" style={{ marginTop: 40 }}>
          <span aria-hidden="true">▲</span>
          <div>
            <strong>Cannot reach the API.</strong>
            <div className="small" style={{ marginTop: 4 }}>{error}</div>
            <div className="small muted" style={{ marginTop: 6 }}>
              Start it with <code className="mono">npm run api</code>, and make sure the database exists
              (<code className="mono">npm run migrate &amp;&amp; npm run ingest</code>).
            </div>
          </div>
        </div>
      </div>
    );
  }

  const activeTab: View['name'] = view.name === 'pillar' ? 'overview' : view.name === 'series' ? 'overview' : view.name;
  const stale = (dash?.health.staleSeries ?? 0) > 0;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">W</div>
          <div>
            <h1>World Dashboard</h1>
            <p className="brand-sub">Global economic health, from a sound-money perspective</p>
          </div>
        </div>

        <nav className="nav" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setView({ name: t.id } as View)}
              aria-current={activeTab === t.id ? 'page' : undefined}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="spacer" />

        {dash && (
          <span className={`live-dot${stale ? ' stale' : ''}`}>
            {stale ? `${dash.health.staleSeries} stale` : 'All feeds current'} · {fmtDate(dash.asOf)}
          </span>
        )}
        <button
          className="icon-button"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          aria-label="Toggle light and dark theme"
          title="Toggle light and dark theme"
        >
          <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
        </button>
      </header>

      {!dash ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          {view.name === 'overview' && (
            <Overview
              dash={dash}
              markets={markets}
              onOpenPillar={openPillar}
              onOpenSeries={openSeries}
              onOpenMarkets={() => setView({ name: 'markets' })}
            />
          )}
          {view.name === 'markets' && (
            markets
              ? (
                <MarketsView
                  markets={markets}
                  group={view.group}
                  onSelectGroup={(g) => setView({ name: 'markets', group: g })}
                  onOpenSeries={openSeries}
                />
              )
              : <div className="loading">Loading markets…</div>
          )}
          {view.name === 'pillar' && (
            <PillarView
              pillar={view.pillar}
              onBack={() => setView({ name: 'overview' })}
              onOpenSeries={openSeries}
            />
          )}
          {view.name === 'series' && <SeriesView id={view.id} onBack={() => setView({ name: 'overview' })} />}
          {view.name === 'events' && <EventsView />}
          {view.name === 'sources' && <SourcesView dash={dash} />}
        </>
      )}
    </div>
  );
}
