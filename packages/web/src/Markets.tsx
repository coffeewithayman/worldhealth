import { useMemo, useState } from 'react';
import type { BoardGroup, ChangeWindow, Markets, Quote } from './api';
import { ChangeChip, CurveChart, leadWindowFor, RangeBar, SectionHead, Sparkline, WINDOW_LABEL } from './components';
import { fmtAge, fmtCadence, fmtDate, fmtPct, fmtPercentile, fmtValue } from './format';
import { shortUnit } from './Overview';

type SortKey = 'label' | 'value' | 'lead' | 'y1' | 'range' | 'pct';

const COLUMNS: Array<{ key: ChangeWindow; label: string }> = [
  { key: 'd1', label: '1D' },
  { key: 'w1', label: '1W' },
  { key: 'm1', label: '1M' },
  { key: 'ytd', label: 'YTD' },
  { key: 'y1', label: '1Y' },
];

export function MarketsView({ markets, group: groupParam, onSelectGroup, onOpenSeries }: {
  markets: Markets;
  /** Selected board, from the URL — so a board is linkable. */
  group?: string;
  onSelectGroup: (id: string) => void;
  onOpenSeries: (id: string) => void;
}) {
  const groupId = markets.groups.some((g) => g.id === groupParam)
    ? groupParam!
    : markets.groups[0]?.id ?? 'fx';
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'label', dir: 1 });

  const group = markets.groups.find((g) => g.id === groupId) ?? markets.groups[0]!;
  const showGold = group.rows.some((r) => r.vsGold);

  const rows = useMemo(() => sortRows(filterRows(group.rows, query), sort), [group, query, sort]);

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: key === 'label' ? 1 : -1 }));

  const arrow = (key: SortKey) => (sort.key === key ? <span className="sort-arrow">{sort.dir === 1 ? '▲' : '▼'}</span> : null);

  return (
    <div className="stack">
      <div>
        <SectionHead title="Markets" aside={`as of ${fmtDate(markets.asOf)}`} />
        <p className="blurb">
          Prices, rates and physical inputs, each with its move over five windows, its position inside
          the last 52 weeks, and where it sits in its own five-year distribution. Every row links to
          the full series with its source and revision history.
        </p>
      </div>

      {/* One filter row above everything it scopes — never per-card controls. */}
      <div className="toolbar">
        <div className="seg">
          {markets.groups.map((g) => (
            <button key={g.id} onClick={() => onSelectGroup(g.id)} aria-current={g.id === groupId}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <input
          className="search"
          type="search"
          placeholder="Filter rows…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter rows"
        />
      </div>

      <BoardTable
        group={group}
        rows={rows}
        showGold={showGold}
        onOpenSeries={onOpenSeries}
        onSort={toggle}
        arrow={arrow}
      />

      {group.id === 'rates' && markets.curve.today.length > 0 && (
        <section className="card">
          <div className="card-title">US Treasury par yield curve</div>
          <p className="blurb" style={{ marginBottom: 10 }}>
            The whole curve at once, against a month and a year ago. An inversion — the short end above
            the long end — has preceded every US recession since 1955; the re-steepening out of one is
            what has actually coincided with the downturn arriving.
          </p>
          <CurveChart
            series={[
              { label: `Today (${fmtDate(markets.curve.asOf)})`, color: 'var(--series-1)', emphasis: true, points: markets.curve.today },
              { label: '1 month ago', color: 'var(--text-muted)', emphasis: false, points: markets.curve.monthAgo },
              { label: '1 year ago', color: 'var(--border-strong)', emphasis: false, points: markets.curve.yearAgo },
            ]}
          />
        </section>
      )}
    </div>
  );
}

function BoardTable({ group, rows, showGold, onOpenSeries, onSort, arrow }: {
  group: BoardGroup;
  rows: Quote[];
  showGold: boolean;
  onOpenSeries: (id: string) => void;
  onSort: (k: SortKey) => void;
  arrow: (k: SortKey) => React.ReactNode;
}) {
  return (
    <section className="card flush">
      <div className="card-pad" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="card-title" style={{ marginBottom: 6 }}>{group.label}</div>
        <p className="blurb" style={{ margin: 0 }}>{group.blurb}</p>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => onSort('label')}>Instrument {arrow('label')}</th>
              <th className="num sortable" onClick={() => onSort('value')}>Last {arrow('value')}</th>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={`num${c.key === 'y1' ? ' sortable' : ''}`}
                  onClick={c.key === 'y1' ? () => onSort('y1') : undefined}
                >
                  {c.label} {c.key === 'y1' ? arrow('y1') : null}
                </th>
              ))}
              {showGold && <th className="num" title="Change in this currency's value measured in gold over one year">vs Gold 1Y</th>}
              <th style={{ width: 104 }}>1Y trend</th>
              <th className="sortable" style={{ width: 118 }} onClick={() => onSort('range')}>52-week range {arrow('range')}</th>
              <th className="num sortable" onClick={() => onSort('pct')} title="Where the latest value sits in its own five-year distribution">5Y rank {arrow('pct')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => {
              const usePct = q.pctMeaningful;
              return (
                <tr key={q.seriesId} className="rowlink" onClick={() => onOpenSeries(q.seriesId)}>
                  <td style={{ maxWidth: 300 }}>
                    <div className="row-name">{q.label}</div>
                    <div className="row-sub">
                      {fmtCadence(q.cadence)} · {fmtDate(q.last?.date)} · {fmtAge(q.ageDays)}
                      {q.stale && <span className="badge badge-stale" style={{ marginLeft: 6, fontSize: 8.5, padding: '0 5px' }}>stale</span>}
                    </div>
                  </td>
                  <td className="num" style={{ fontWeight: 600, fontSize: 13 }}>
                    {fmtValue(q.last?.value, q.decimals)}
                    {shortUnit(q.unit) && <span className="muted" style={{ fontSize: 10.5, marginLeft: 3 }}>{shortUnit(q.unit)}</span>}
                  </td>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className="num">
                      <ChangeChip change={q.changes[c.key]} rising={q.rising} usePct={usePct} unit={q.unit} bp={q.bp} />
                    </td>
                  ))}
                  {showGold && (
                    <td className="num">
                      {q.vsGold
                        ? <span className={`chip ${q.vsGold.pct < 0 ? 'up-bad' : 'down-bad'}`}>
                            <span className="arrow" aria-hidden="true">{q.vsGold.pct < 0 ? '▼' : '▲'}</span>
                            {fmtPct(q.vsGold.pct, 1)}
                          </span>
                        : <span className="chip none">—</span>}
                    </td>
                  )}
                  <td><Sparkline data={q.spark} width={96} height={26} /></td>
                  <td><RangeBar range={q.range52w} decimals={q.decimals} /></td>
                  <td className="num muted">{fmtPercentile(q.percentile5y)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="muted small" style={{ textAlign: 'center', padding: '28px 0' }}>No rows match that filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card-pad" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="small muted" style={{ lineHeight: 1.6 }}>
          Leading window for this board: <strong>{WINDOW_LABEL[group.lead]}</strong>. Percent changes are
          suppressed on series that cross zero — spreads and net balances show the change in their own
          units instead, because a spread moving from +2bp to −2bp is not “−200%”.
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ helpers */

function filterRows(rows: Quote[], query: string): Quote[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    r.label.toLowerCase().includes(q)
    || r.seriesId.toLowerCase().includes(q)
    || (r.hint ?? '').toLowerCase().includes(q));
}

function sortRows(rows: Quote[], sort: { key: SortKey; dir: 1 | -1 }): Quote[] {
  const val = (q: Quote): number | string => {
    switch (sort.key) {
      case 'label': return q.label;
      case 'value': return q.last?.value ?? -Infinity;
      case 'y1': return q.changes.y1?.pct ?? -Infinity;
      case 'range': return q.range52w?.pos ?? -Infinity;
      case 'pct': return q.percentile5y ?? -Infinity;
      case 'lead': return q.changes[leadWindowFor(q.cadence)]?.pct ?? -Infinity;
    }
  };
  return [...rows].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * sort.dir;
    }
    return (av - bv) * sort.dir;
  });
}
