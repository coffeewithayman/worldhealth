import { useEffect, useState } from 'react';
import {
  api, PILLAR_BLURBS, PILLAR_LABELS, statusFor, STATUS_COLOR, STATUS_ICON, statusLabel,
  type IndicatorDetail, type PillarDetail, type SeriesDetail,
} from './api';
import {
  BandScale, ChangeChip, Gauge, leadWindowFor, Meter, RangeBar, SectionHead, Sparkline, WINDOW_LABEL,
} from './components';
import { fmtAge, fmtCadence, fmtDate, fmtPercentile, fmtValue } from './format';
import { LineChart } from './LineChart';
import { shortUnit } from './Overview';

/* -------------------------------------------------------------------- pillar */

export function PillarView({ pillar, onBack, onOpenSeries }: {
  pillar: string; onBack: () => void; onOpenSeries: (id: string) => void;
}) {
  const [data, setData] = useState<PillarDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    api.pillar(pillar).then(setData).catch((e: Error) => setErr(e.message));
  }, [pillar]);

  if (err) return <div className="notice">▲ {err}</div>;
  if (!data) return <div className="loading">Loading…</div>;

  const st = statusFor(data.score);
  const colour = STATUS_COLOR[st];

  // Ranked by contribution, not by score: the reader's first question is "what
  // is making this number what it is", and a high-scoring indicator with a tiny
  // weight is not the answer.
  const ranked = [...data.indicators].sort((a, b) => b.contribution - a.contribution);
  const top = ranked.slice(0, 4);

  return (
    <div className="stack">
      <div>
        <button className="back" onClick={onBack}>← Overview</button>

        <section className="card">
          <div className="hero">
            <div className="gauge-wrap">
              <Gauge value={data.score} size={186} />
              <div className="gauge-centre">
                <div className="gauge-value" style={{ color: colour, fontSize: 46 }}>
                  {data.score === null ? '—' : data.score.toFixed(0)}
                </div>
                <div className="gauge-label">out of 100</div>
              </div>
            </div>

            <div>
              <div className="hero-regime" style={{ color: colour }}>
                <span aria-hidden="true">{STATUS_ICON[st]}</span>
                <span>{PILLAR_LABELS[pillar] ?? pillar} — {statusLabel(data.score)}</span>
              </div>
              <p className="hero-lede">{PILLAR_BLURBS[pillar]}</p>
              <p className="hero-lede" style={{ marginTop: 8 }}>
                {top.length > 0 ? (
                  <>
                    Most of this score comes from{' '}
                    <strong>{top.slice(0, 2).map((i) => i.label).join(' and ')}</strong>
                    {top[0] && <> ({(top[0].contribution * 100).toFixed(0)}%
                      {top[1] ? ` and ${(top[1].contribution * 100).toFixed(0)}%` : ''} of the weighted total)</>}.
                  </>
                ) : 'No indicator in this pillar currently has usable data.'}
              </p>
              <div className="hero-facts">
                <div className="hero-fact">
                  <div className="k">Indicators scored</div>
                  <div className="v">{data.indicators.length}<span className="muted" style={{ fontSize: 13 }}> / {data.indicators.length + data.missing.length}</span></div>
                </div>
                <div className="hero-fact">
                  <div className="k">Coverage</div>
                  <div className="v" style={{ color: data.coverage < 0.34 ? 'var(--status-serious)' : undefined }}>
                    {(data.coverage * 100).toFixed(0)}%
                  </div>
                </div>
                <div className="hero-fact">
                  <div className="k">Total weight</div>
                  <div className="v">{data.indicators.reduce((a, i) => a + i.weight, 0).toFixed(1)}</div>
                </div>
              </div>
              <div style={{ marginTop: 16, maxWidth: 400 }}><BandScale value={data.score} /></div>
            </div>

            <div className="hero-side">
              <div className="card-title" style={{ marginBottom: 8 }}>What is driving it</div>
              <div className="stack-sm">
                {top.map((i) => (
                  <div key={i.seriesId}>
                    <div className="row" style={{ gap: 6, justifyContent: 'space-between', fontSize: 11.5 }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{i.label}</span>
                      <span className="mono muted" style={{ fontSize: 11 }}>{(i.contribution * 100).toFixed(0)}%</span>
                    </div>
                    <div className="meter" style={{ marginTop: 4, height: 5 }}>
                      <div
                        className="meter-fill"
                        style={{ width: `${Math.min(100, i.contribution * 100)}%`, background: STATUS_COLOR[statusFor(i.score)] }}
                      />
                    </div>
                  </div>
                ))}
                {ranked.length > top.length && (
                  <div className="small muted">+ {ranked.length - top.length} more below</div>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      <section>
        <SectionHead title="Indicators" aside={`${data.indicators.length} scored · ranked by contribution`} />
        <p className="blurb">
          Every indicator shows its current reading, the transform used to turn that reading into a
          0–100 stress score, and the arithmetic that produced it. Nothing here is a black box: if a
          number looks wrong, the line under it says why it is what it is.
        </p>
        <div className="ind-grid">
          {ranked.map((ind) => <IndicatorCard key={ind.seriesId} ind={ind} onOpen={onOpenSeries} />)}
        </div>
      </section>

      {data.missing.length > 0 && (
        <section className="card">
          <div className="card-title">{data.missing.length} indicator(s) excluded</div>
          <p className="blurb" style={{ marginBottom: 8 }}>
            These are counted against coverage rather than silently dropped, so a thin score is
            visibly thin. Usually a missing API key or a series that has gone past its staleness
            budget — the Sources tab says which.
          </p>
          <div className="row" style={{ gap: 6 }}>
            {data.missing.map((m) => <span key={m} className="badge badge-soft mono">{m}</span>)}
          </div>
        </section>
      )}
    </div>
  );
}

function IndicatorCard({ ind, onOpen }: { ind: IndicatorDetail; onOpen: (id: string) => void }) {
  const st = statusFor(ind.score);
  const colour = STATUS_COLOR[st];
  const cadence = ind.meta?.cadence ?? 'daily';
  const win = leadWindowFor(cadence);
  const change = ind.changes[win] ?? ind.changes.prev;

  return (
    <button className="ind" onClick={() => onOpen(ind.seriesId)}>
      <div className="ind-top">
        <div style={{ minWidth: 0 }}>
          <div className="ind-name">{ind.label}</div>
          <div className="ind-raw">
            {fmtValue(ind.rawValue)} {ind.meta?.unit ? shortUnit(ind.meta.unit) || ind.meta.unit : ''}
          </div>
        </div>
        <div className="ind-score" style={{ color: colour }}>
          {ind.score.toFixed(0)}
          <small style={{ color: colour }}>{statusLabel(ind.score)}</small>
        </div>
      </div>

      <Meter value={ind.score} status={st} />

      <div className="ind-stats">
        <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <ChangeChip
              change={change}
              rising="neutral"
              usePct={ind.pctMeaningful}
              unit={ind.meta?.unit}
              suffix={` ${WINDOW_LABEL[win]}`}
            />
            {ind.percentile5y !== null && (
              <span className="small muted">{fmtPercentile(ind.percentile5y)} pctile, 5y</span>
            )}
          </div>
          <div className="ind-meta">
            <span>weight {ind.weight.toFixed(1)}</span>
            <span>·</span>
            <span>{(ind.contribution * 100).toFixed(0)}% of pillar</span>
            <span>·</span>
            <span>{fmtCadence(cadence)}</span>
          </div>
        </div>
        <Sparkline data={ind.spark} width={104} height={30} />
      </div>

      <div className="ind-why">{ind.explanation}</div>

      <div className="ind-meta">
        <span className="mono">{ind.seriesId}</span>
        <span>·</span>
        <span>{ind.transform}</span>
        <span>·</span>
        <span>{fmtDate(ind.obsDate)} ({fmtAge(ind.ageDays)})</span>
      </div>
    </button>
  );
}

/* -------------------------------------------------------------------- series */

const RANGES = [
  { id: '1m', label: '1M', days: 31 },
  { id: '6m', label: '6M', days: 183 },
  { id: '1y', label: '1Y', days: 365 },
  { id: '5y', label: '5Y', days: 1826 },
  { id: 'all', label: 'All', days: Infinity },
] as const;

export function SeriesView({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<SeriesDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('1y');

  useEffect(() => {
    setData(null);
    setErr(null);
    api.series(id).then(setData).catch((e: Error) => setErr(e.message));
  }, [id]);

  if (err) return <div className="notice">▲ {err}</div>;
  if (!data) return <div className="loading">Loading…</div>;

  const days = RANGES.find((r) => r.id === range)?.days ?? 365;
  const cutoff = days === Infinity
    ? '0000-00-00'
    : new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const points = data.observations.filter((o) => o.obsDate >= cutoff).map((o) => ({ date: o.obsDate, value: o.value }));

  const stats = data.stats;
  const stale = data.health?.stale ?? false;
  const usePct = stats.pctMeaningful;
  const cadence = data.series.cadence;
  // A zero line only earns its ink where zero is a real boundary — a spread
  // crossing it inverts, a growth rate crossing it contracts.
  const crossesZero = stats.range52w ? stats.range52w.low < 0 && stats.range52w.high > 0 : false;

  return (
    <div className="stack">
      <div>
        <button className="back" onClick={onBack}>← Back</button>
        <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.015em' }}>{data.series.name}</h2>
          {stale && <span className="badge badge-stale">stale · {data.health?.ageDays}d old</span>}
        </div>
        <div className="row small muted" style={{ marginTop: 6, gap: 8 }}>
          <span className="mono">{data.series.id}</span>
          <span>·</span>
          <span>{data.series.unit}</span>
          <span>·</span>
          <span>{fmtCadence(cadence)}</span>
          <span>·</span>
          <span>source: {data.series.sourceId}</span>
          {data.series.sourceUrl && (
            <>
              <span>·</span>
              <a href={data.series.sourceUrl} target="_blank" rel="noreferrer">original data ↗</a>
            </>
          )}
        </div>
      </div>

      {/* Stat tiles first: the answer, then the chart that supports it. */}
      <div className="tiles">
        <div className="tile" style={{ cursor: 'default' }}>
          <div className="tile-label">Latest</div>
          <div className="tile-value">
            {fmtValue(stats.last?.value)}
            <span className="unit">{shortUnit(data.series.unit)}</span>
          </div>
          <div className="small muted" style={{ marginTop: 4, fontSize: 10.5 }}>
            {fmtDate(stats.last?.date)} · {fmtAge(stats.ageDays)}
          </div>
        </div>
        {(['d1', 'm1', 'y1'] as const)
          .filter((w) => stats.changes[w] || w === leadWindowFor(cadence))
          .map((w) => (
            <div key={w} className="tile" style={{ cursor: 'default' }}>
              <div className="tile-label">Change, {WINDOW_LABEL[w]}</div>
              <div className="tile-value" style={{ fontSize: 20 }}>
                <ChangeChip change={stats.changes[w]} rising="neutral" usePct={usePct} unit={data.series.unit} />
              </div>
              <div className="small muted" style={{ marginTop: 4, fontSize: 10.5 }}>
                from {fmtValue(stats.changes[w]?.fromValue)} on {fmtDate(stats.changes[w]?.fromDate)}
              </div>
            </div>
          ))}
        <div className="tile" style={{ cursor: 'default' }}>
          <div className="tile-label">52-week range</div>
          <div style={{ marginTop: 10 }}><RangeBar range={stats.range52w} /></div>
          <div className="small muted" style={{ marginTop: 6, fontSize: 10.5 }}>
            {stats.range52w ? `${(stats.range52w.pos * 100).toFixed(0)}% of the way up the range` : 'not enough history'}
          </div>
        </div>
        <div className="tile" style={{ cursor: 'default' }}>
          <div className="tile-label">5-year rank</div>
          <div className="tile-value">{fmtPercentile(stats.percentile5y)}</div>
          <div className="small muted" style={{ marginTop: 4, fontSize: 10.5 }}>
            percentile of its own 5-year history
          </div>
        </div>
      </div>

      <section className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ margin: 0 }}>
            {points.length.toLocaleString()} observations shown
            <span className="muted" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
              {' '}of {data.observations.length.toLocaleString()} stored
            </span>
          </div>
          <div className="spacer" />
          <div className="seg">
            {RANGES.map((r) => (
              <button key={r.id} onClick={() => setRange(r.id)} aria-current={range === r.id}>{r.label}</button>
            ))}
          </div>
        </div>
        <LineChart
          data={points}
          height={320}
          unit={data.series.unit}
          name={data.series.name}
          fill={!crossesZero}
          refLine={crossesZero ? { value: 0, label: '0' } : undefined}
        />
      </section>

      {data.series.notes && (
        <section className="card">
          <div className="card-title">Why this series is here</div>
          <p style={{ margin: 0, maxWidth: '78ch', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
            {data.series.notes}
          </p>
        </section>
      )}

      <section className="card">
        <div className="card-title">Provenance</div>
        <div className="table-scroll">
          <table>
            <tbody>
              <tr><td className="muted" style={{ width: 200 }}>Series id</td><td className="mono">{data.series.id}</td></tr>
              <tr><td className="muted">Source</td><td>{data.series.sourceId}</td></tr>
              <tr><td className="muted">Unit</td><td>{data.series.unit}</td></tr>
              <tr><td className="muted">Publication cadence</td><td>{fmtCadence(cadence)}</td></tr>
              <tr><td className="muted">Pillar</td><td>{data.series.pillar ?? '—'}</td></tr>
              <tr>
                <td className="muted">Staleness budget</td>
                <td>
                  {data.health?.stalenessBudgetDays ?? '—'} days
                  {data.health && (
                    <span className={data.health.stale ? '' : 'muted'} style={{ marginLeft: 8, color: data.health.stale ? 'var(--status-serious)' : undefined }}>
                      (currently {data.health.ageDays ?? '—'} days old)
                    </span>
                  )}
                </td>
              </tr>
              <tr>
                <td className="muted">First observation</td>
                <td>{fmtDate(data.observations[0]?.obsDate)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
