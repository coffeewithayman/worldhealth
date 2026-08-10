import {
  PILLAR_LABELS, statusFor, STATUS_COLOR, STATUS_ICON, statusLabel,
  type Dashboard, type Markets, type Quote,
} from './api';
import {
  BandScale, ChangeChip, Gauge, leadWindowFor, Meter, SectionHead, Sparkline, WINDOW_LABEL,
} from './components';
import { fmtAge, fmtDate, fmtDateShort, fmtPct, fmtValue } from './format';
import { LineChart } from './LineChart';

export function Overview({ dash, markets, onOpenPillar, onOpenSeries, onOpenMarkets }: {
  dash: Dashboard;
  markets: Markets | null;
  onOpenPillar: (p: string) => void;
  onOpenSeries: (id: string) => void;
  onOpenMarkets: () => void;
}) {
  const score = dash.composite.score;
  const status = statusFor(score);
  const colour = STATUS_COLOR[status];
  const history = dash.compositeHistory.map((h) => ({ date: h.scoreDate, value: h.value }));

  const triggered = dash.watchlist.filter((w) => w.available && w.triggered);
  const unavailable = dash.watchlist.filter((w) => !w.available);
  // Triggered precursors first: the whole point of the panel is the ones that
  // are lit, and making the reader scan a grid of green for them defeats it.
  const watchlist = [...dash.watchlist].sort((a, b) => {
    const rank = (w: typeof a) => (!w.available ? 2 : w.triggered ? 0 : 1);
    return rank(a) - rank(b) || b.severity - a.severity;
  });

  const ranked = [...dash.pillars]
    .filter((p) => p.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const hottest = ranked.slice(0, 2);

  const change30 = compositeChange(dash.compositeHistory, 30);

  return (
    <div className="stack">
      {dash.health.staleSeries > 0 && (
        <div className="notice">
          <span aria-hidden="true">▲</span>
          <div>
            <strong>{dash.health.staleSeries} of {dash.health.totalSeries} series are stale.</strong>{' '}
            Affected panels are showing data older than its refresh budget — see the Sources tab.
          </div>
        </div>
      )}

      <section className="card">
        <div className="hero">
          <div className="gauge-wrap">
            <Gauge value={score} size={208} />
            <div className="gauge-centre">
              <div className="gauge-value" style={{ color: colour }}>{score === null ? '—' : score.toFixed(0)}</div>
              <div className="gauge-label">Composite stress</div>
            </div>
          </div>

          <div>
            <div className="hero-regime" style={{ color: colour }}>
              <span aria-hidden="true">{STATUS_ICON[status]}</span>
              <span>{dash.composite.regime}</span>
            </div>
            <p className="hero-lede">
              {hottest.length > 0 ? (
                <>
                  <strong>{hottest.map((p) => PILLAR_LABELS[p.pillar] ?? p.pillar).join(' and ')}</strong>
                  {' '}
                  {hottest.length > 1 ? 'carry' : 'carries'} the most stress right now
                  {hottest[0]?.score !== null && hottest[0] !== undefined && (
                    <> ({hottest.map((p) => (p.score ?? 0).toFixed(0)).join(' and ')} of 100)</>
                  )}.
                </>
              ) : 'Not enough scored data yet to rank the pillars.'}
              {' '}
              {triggered.length === 0
                ? 'No depression precursor is currently triggered.'
                : `${triggered.length} depression precursor${triggered.length > 1 ? 's are' : ' is'} triggered.`}
            </p>

            <div className="hero-facts">
              <div className="hero-fact">
                <div className="k">Pillars elevated</div>
                <div className="v">{dash.composite.pillarsElevated}<span className="muted" style={{ fontSize: 13 }}> / {dash.pillars.length}</span></div>
              </div>
              <div className="hero-fact">
                <div className="k">Precursors lit</div>
                <div className="v" style={{ color: triggered.length ? 'var(--status-critical)' : undefined }}>
                  {triggered.length}<span className="muted" style={{ fontSize: 13 }}> / {dash.watchlist.length}</span>
                </div>
              </div>
              <div className="hero-fact">
                <div className="k">Pillar coverage</div>
                <div className="v">{(dash.composite.coverage * 100).toFixed(0)}%</div>
              </div>
              <div className="hero-fact">
                <div className="k">30-day move</div>
                <div className="v">{change30 === null ? '—' : `${change30 >= 0 ? '+' : ''}${change30.toFixed(1)}`}</div>
              </div>
            </div>
            <div style={{ marginTop: 16, maxWidth: 420 }}><BandScale value={score} /></div>
          </div>

          <div className="hero-side">
            <div className="card-title" style={{ marginBottom: 4 }}>Composite history</div>
            {history.length > 1 ? (
              <LineChart data={history} height={132} color={colour} name="Composite stress" />
            ) : (
              <div className="muted small" style={{ lineHeight: 1.6 }}>
                {history.length} scored day so far. The trend of this score matters more than
                today's level, and it builds as the daily job runs.
              </div>
            )}
          </div>
        </div>
      </section>

      {markets && markets.headline.length > 0 && (
        <section>
          <SectionHead
            title="Financial core"
            aside={<button onClick={onOpenMarkets} style={{ color: 'var(--series-1)' }}>All markets →</button>}
          />
          <p className="blurb">
            What money, metal, energy and credit cost today. Every tile is a live series — click one
            for its full history, provenance and the arithmetic behind it.
          </p>
          <div className="tiles">
            {markets.headline.map((q) => <QuoteTile key={q.seriesId} q={q} onOpen={onOpenSeries} />)}
          </div>
        </section>
      )}

      <section>
        <SectionHead
          title="Depression precursors"
          aside={
            <>
              <span style={{ color: triggered.length ? 'var(--status-critical)' : 'var(--status-good)', fontWeight: 600 }}>
                {triggered.length} triggered
              </span>
              {unavailable.length > 0 && <span className="muted"> · {unavailable.length} unavailable</span>}
            </>
          }
        />
        <p className="blurb">
          Eleven conditions that have preceded depressions rather than ordinary recessions. These are
          binary tests with explicit thresholds, not scores — each one states what would have to
          happen for it to fire.
        </p>
        <div className="watch-grid">
          {watchlist.map((w) => {
            const cls = !w.available ? 'unknown' : w.triggered ? 'triggered' : 'clear';
            const icon = !w.available ? '?' : w.triggered ? '■' : '●';
            const tone = !w.available ? 'var(--status-unknown)' : w.triggered ? 'var(--status-critical)' : 'var(--status-good)';
            return (
              <div key={w.id} className={`watch ${cls}`}>
                <div className="watch-head">
                  <span style={{ color: tone }} aria-hidden="true">{icon}</span>
                  <span>{w.name}</span>
                </div>
                <div className="watch-detail">
                  <strong style={{ color: tone }}>
                    {!w.available ? 'No data' : w.triggered ? 'TRIGGERED' : 'Clear'}
                  </strong>
                  {' — '}{w.detail}
                </div>
                <div className="watch-why">{w.rationale}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <SectionHead title="Pillars" aside="0 = calm · 100 = crisis" />
        <p className="blurb">
          Nine groupings, each scored from its own indicators and weighted into the composite above.
          Open one to see every indicator, what it is worth today, and exactly how it moved the score.
        </p>
        <div className="pillar-grid">
          {dash.pillars.map((p) => {
            const st = statusFor(p.score);
            const excluded = p.coverage < 0.34;
            return (
              <button key={p.pillar} className="pillar" onClick={() => onOpenPillar(p.pillar)}>
                <div className="pillar-head">
                  <span className="pillar-name">{PILLAR_LABELS[p.pillar] ?? p.pillar}</span>
                  <span className="pillar-score" style={{ color: STATUS_COLOR[st] }}>
                    {p.score === null ? '—' : p.score.toFixed(0)}
                  </span>
                </div>
                <div style={{ marginTop: 9 }}><Meter value={p.score} status={st} /></div>
                <div className="pillar-foot">
                  <span style={{ color: STATUS_COLOR[st], fontWeight: 550 }}>{statusLabel(p.score)}</span>
                  <span>
                    {p.indicatorCount} ind · {(p.coverage * 100).toFixed(0)}% cov
                    {excluded && ' · excluded'}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- quote tile */

export function QuoteTile({ q, onOpen }: { q: Quote; onOpen: (id: string) => void }) {
  const win = leadWindowFor(q.cadence);
  const change = q.changes[win] ?? q.changes.prev;
  const usePct = q.pctMeaningful;
  return (
    <button className="tile" onClick={() => onOpen(q.seriesId)} title={q.hint ?? undefined}>
      <div className="tile-label">
        <span>{q.label}</span>
        {q.stale && <span className="badge badge-stale" style={{ fontSize: 8.5, padding: '1px 5px' }}>stale</span>}
      </div>
      <div className="tile-value">
        {fmtValue(q.last?.value, q.decimals)}
        {q.unit && <span className="unit">{shortUnit(q.unit)}</span>}
      </div>
      <div className="tile-foot">
        <div>
          <ChangeChip change={change} rising={q.rising} usePct={usePct} unit={q.unit} bp={q.bp} suffix={` ${WINDOW_LABEL[win]}`} />
          <div className="tile-when" title={fmtDate(q.last?.date)}>
            {fmtAge(q.ageDays)} · {fmtDateShort(q.last?.date)}
          </div>
        </div>
        <Sparkline data={q.spark} width={78} height={26} />
      </div>
    </button>
  );
}

/** Units are written for the drill-down; a tile has room for a short form only. */
export function shortUnit(unit: string): string {
  const map: Record<string, string> = {
    'USD per troy ounce': '$/oz',
    'USD per metric ton': '$/t',
    'USD per pound': '$/lb',
    'USD per barrel': '$/bbl',
    'USD per MMBtu': '$/MMBtu',
    'basis points': 'bp',
    percent: '%',
    index: '',
    USD: '$',
  };
  if (map[unit] !== undefined) return map[unit];
  if (unit.startsWith('index')) return '';
  if (unit.includes(' per ')) return unit.split(' per ')[1] ? `/${unit.split(' per ')[1]}` : unit;
  return unit.length <= 8 ? unit : '';
}

/** Composite score change over a trailing window, in points. */
function compositeChange(history: Array<{ scoreDate: string; value: number }>, days: number): number | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1]!;
  const cutoff = new Date(new Date(last.scoreDate).getTime() - days * 86_400_000).toISOString().slice(0, 10);
  let ref = history[0]!;
  for (const h of history) { if (h.scoreDate <= cutoff) ref = h; }
  if (ref.scoreDate === last.scoreDate) return null;
  return last.value - ref.value;
}

export { fmtPct };
