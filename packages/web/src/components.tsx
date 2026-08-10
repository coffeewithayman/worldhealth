import { useMemo } from 'react';
import {
  SCORE_BANDS, statusFor, STATUS_COLOR, statusLabel,
  type Change, type Point, type RiseMeaning, type Status,
} from './api';
import { fmtPct, fmtRangeEnd, fmtSigned, fmtValue } from './format';

/* ---------------------------------------------------------------- sparkline */

interface SparklineProps {
  data: Point[];
  width?: number;
  height?: number;
  /** Overrides the de-emphasised default. Used where the row already has a colour. */
  color?: string;
  /** Draw a hairline at this value — a zero line on a spread, a threshold on a score. */
  refValue?: number;
}

/**
 * Trend line for a tile or table row.
 *
 * De-emphasised by design: the line is drawn in muted ink with a wash beneath
 * it, and only the final point wears the accent. A table of forty sparklines
 * all shouting in full-saturation blue is a texture, not information.
 */
export function Sparkline({ data, width = 96, height = 28, color, refValue }: SparklineProps) {
  const geom = useMemo(() => {
    if (data.length < 2) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const d of data) { if (d.value < min) min = d.value; if (d.value > max) max = d.value; }
    if (refValue !== undefined) { min = Math.min(min, refValue); max = Math.max(max, refValue); }
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.12;
    min -= pad; max += pad;
    const x = (i: number) => (i / (data.length - 1)) * (width - 5) + 2.5;
    const y = (v: number) => height - 3 - ((v - min) / (max - min)) * (height - 6);
    const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
    const area = `${line} L${x(data.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
    return { x, y, line, area, min, max };
  }, [data, width, height, refValue]);

  if (!geom) return <svg width={width} height={height} aria-hidden="true" />;
  const stroke = color ?? 'var(--text-muted)';
  const last = data[data.length - 1]!;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: 'block' }}>
      <path d={geom.area} fill={stroke} opacity="0.1" />
      {refValue !== undefined && (
        <line x1="2.5" x2={width - 2.5} y1={geom.y(refValue)} y2={geom.y(refValue)} stroke="var(--grid)" strokeWidth="1" />
      )}
      <path d={geom.line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle
        cx={geom.x(data.length - 1)} cy={geom.y(last.value)} r="2.6"
        fill={color ?? 'var(--series-1)'} stroke="var(--surface-1)" strokeWidth="1.6"
      />
    </svg>
  );
}

/* -------------------------------------------------------------- change chip */

interface ChangeChipProps {
  change: Change | null | undefined;
  /** Whether a rise is a better or worse reading. Neutral rows wear plain ink. */
  rising?: RiseMeaning;
  /** False for spreads and yields, where a percent change is arithmetic noise. */
  usePct?: boolean;
  decimals?: number;
  /** Appended after the number, e.g. `1d` or `vs Jan`. */
  suffix?: string;
  /** The series' unit — decides whether an absolute move carries a `pp` suffix. */
  unit?: string;
  /** Quote the absolute move in basis points. Curated per row, never guessed. */
  bp?: boolean;
}

/**
 * How to render an absolute move.
 *
 * Rates move in basis points. Writing "+0.42" beside a 4.65% yield forces the
 * reader to do the ×100 themselves, and half of them will read it as 42%.
 */
export function absDisplayFor(unit: string | undefined, bp = false): { scale: number; suffix: string; decimals: number } {
  const u = (unit ?? '').toLowerCase();
  if (u === 'basis points') return { scale: 1, suffix: 'bp', decimals: 0 };
  // Yields and spreads are quoted in basis points; a diffusion index or an
  // unemployment rate shares the "percent" unit but moves in points, and
  // "-810bp" for an eight-point swing in a survey reads as nonsense. Which of
  // the two a row is comes from the board definition, not from the unit.
  if (bp) return { scale: 100, suffix: 'bp', decimals: 0 };
  if (u === 'percent' || u === 'percentage points' || u.startsWith('percent of') || u.startsWith('percent ')) {
    return { scale: 1, suffix: 'pp', decimals: 2 };
  }
  return { scale: 1, suffix: '', decimals: 2 };
}

/**
 * Signed delta with direction.
 *
 * Direction is always carried by an arrow glyph, so the chip survives greyscale
 * and colour-blindness. Colour is added only where a direction genuinely means
 * better or worse — an oil price rising is neither, and painting it green would
 * be an editorial claim the data does not make.
 */
export function ChangeChip({ change, rising = 'neutral', usePct = true, decimals = 2, suffix, unit, bp = false }: ChangeChipProps) {
  if (!change || !Number.isFinite(usePct ? change.pct : change.abs)) {
    return <span className="chip none">—</span>;
  }
  const abs = absDisplayFor(unit, bp);
  const v = usePct ? change.pct : change.abs * abs.scale;
  const dir = Math.abs(v) < 5e-3 ? 'flat' : v > 0 ? 'up' : 'down';
  const cls = rising === 'neutral' || dir === 'flat'
    ? (dir === 'flat' ? 'flat' : 'neutral')
    : `${dir}-${rising}`;
  const text = usePct ? fmtPct(v, decimals) : `${fmtSigned(v, abs.decimals)}${abs.suffix}`;
  return (
    <span className={`chip ${cls}`} title={`from ${fmtValue(change.fromValue)} on ${change.fromDate}`}>
      <span className="arrow" aria-hidden="true">{dir === 'flat' ? '·' : dir === 'up' ? '▲' : '▼'}</span>
      <span>{text}</span>
      {suffix && <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>{suffix}</span>}
    </span>
  );
}

/* ----------------------------------------------------------------- range bar */

/**
 * Where today's value sits inside its own 52-week range.
 *
 * Answers the question a bare price cannot: is this high or low *for this
 * thing*. A gold price of 4,335 means nothing without knowing the year ran
 * from 3,100 to 4,600.
 */
export function RangeBar({ range, decimals, showEnds = true }: {
  range: { low: number; high: number; pos: number } | null;
  decimals?: number | null;
  showEnds?: boolean;
}) {
  if (!range) return <span className="muted small">—</span>;
  const pos = Math.min(1, Math.max(0, range.pos));
  return (
    <div style={{ minWidth: 92 }}>
      <div
        className="range-bar"
        style={{ ['--pos' as string]: `${(pos * 100).toFixed(1)}%` }}
        role="img"
        aria-label={`${(pos * 100).toFixed(0)}% of the way up a 52-week range from ${fmtValue(range.low, decimals)} to ${fmtValue(range.high, decimals)}`}
      />
      {showEnds && (
        <div className="range-ends">
          {/* Both ends take the same form — `9,671.9 … 13.6K` reads as two
              different quantities rather than the two ends of one range. */}
          <span>{fmtRangeEnd(range.low, range.high)}</span>
          <span>{fmtRangeEnd(range.high, range.high)}</span>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- meter */

export function Meter({ value, status }: { value: number | null; status?: Status }) {
  const st = status ?? statusFor(value);
  return (
    <div className="meter" role="img" aria-label={`${value === null ? 'no' : value.toFixed(0)} out of 100 — ${statusLabel(value)}`}>
      <div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%`, background: STATUS_COLOR[st] }} />
    </div>
  );
}

/* --------------------------------------------------------------------- gauge */

/**
 * The composite score, as a 240° arc.
 *
 * One hero figure per view, and this is it. The arc exists to place the number
 * on a scale — 62 out of 100 with a coloured band beneath it is legible in a
 * glance in a way that a bare `62` never is.
 */
export function Gauge({ value, size = 200 }: { value: number | null; size?: number }) {
  const status = statusFor(value);
  const colour = STATUS_COLOR[status];
  const stroke = 13;
  const r = (size - stroke) / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  const START = 150;
  const SWEEP = 240;

  const pt = (angleDeg: number) => {
    const a = (angleDeg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const arc = (fromDeg: number, toDeg: number) => {
    const [x0, y0] = pt(fromDeg);
    const [x1, y1] = pt(toDeg);
    const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
  };

  const frac = value === null ? 0 : Math.max(0, Math.min(100, value)) / 100;

  return (
    <svg width={size} height={size * 0.88} viewBox={`0 0 ${size} ${size * 0.88}`} role="img"
      aria-label={`Composite stress ${value === null ? 'unavailable' : value.toFixed(0)} out of 100 — ${statusLabel(value)}`}>
      <path d={arc(START, START + SWEEP)} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} strokeLinecap="round" />
      {value !== null && frac > 0.001 && (
        <path d={arc(START, START + SWEEP * frac)} fill="none" stroke={colour} strokeWidth={stroke} strokeLinecap="round" />
      )}
      {/* Band boundaries as hairline ticks, so the reader can see where the
          colour is about to change without a separate legend lookup. */}
      {SCORE_BANDS.slice(1).map((b) => {
        const a = ((START + SWEEP * (b.from / 100)) * Math.PI) / 180;
        const inner = r - stroke / 2 - 1;
        const outer = r + stroke / 2 + 1;
        return (
          <line
            key={b.from}
            x1={cx + inner * Math.cos(a)} y1={cy + inner * Math.sin(a)}
            x2={cx + outer * Math.cos(a)} y2={cy + outer * Math.sin(a)}
            stroke="var(--surface-0)" strokeWidth="2"
          />
        );
      })}
    </svg>
  );
}

/** The band scale printed beneath the gauge. */
export function BandScale({ value }: { value: number | null }) {
  const active = statusLabel(value);
  return (
    <div className="bands">
      {SCORE_BANDS.map((b) => (
        <div key={b.label} className={`band${b.label === active ? ' on' : ''}`}>
          <i style={{ background: STATUS_COLOR[b.status], opacity: b.label === active ? 1 : 0.35 }} />
          <span>{b.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- section head */

export function SectionHead({ title, aside, children }: {
  title: string; aside?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      <div className="rule" />
      {aside && <div className="aside">{aside}</div>}
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- curve chart */

export interface CurveSeries { label: string; color: string; emphasis: boolean; points: Array<{ label: string; value: number | null }> }

/**
 * The Treasury curve, three vintages on one axis.
 *
 * Emphasis rather than three equal colours: today's curve is the subject and
 * wears the accent, while the historical vintages recede into grey. That is
 * also why this can carry three series without a colour-matching problem.
 */
export function CurveChart({ series, height = 230 }: { series: CurveSeries[]; height?: number }) {
  const labels = series[0]?.points.map((p) => p.label) ?? [];
  const values = series.flatMap((s) => s.points.map((p) => p.value)).filter((v): v is number => v !== null);
  if (labels.length === 0 || values.length === 0) return <div className="muted small">No curve data</div>;

  const W = 720;
  const PAD = { top: 14, right: 46, bottom: 26, left: 40 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  const span = max - min || 1;
  min -= span * 0.18; max += span * 0.18;

  const x = (i: number) => PAD.left + (i / Math.max(1, labels.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (height - PAD.top - PAD.bottom) * (1 - (v - min) / (max - min));

  const ticks = niceTicks(min, max, 4);

  return (
    <div>
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img"
        aria-label="US Treasury par yield curve, today against one month and one year ago">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(t) + 3.5} className="axis-label" textAnchor="end">{t.toFixed(1)}</text>
          </g>
        ))}
        {labels.map((l, i) => (
          <text key={l} x={x(i)} y={height - 8} className="axis-label" textAnchor="middle">{l}</text>
        ))}
        {series.map((s) => {
          const pts = s.points
            .map((p, i) => (p.value === null ? null : `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`))
            .filter((p): p is string => p !== null);
          if (pts.length < 2) return null;
          let lastIdx = -1;
          for (let i = 0; i < s.points.length; i++) if (s.points[i]!.value !== null) lastIdx = i;
          const lastPoint = lastIdx >= 0 ? s.points[lastIdx]! : null;
          return (
            <g key={s.label}>
              <path
                d={`M${pts.join(' L')}`} fill="none" stroke={s.color}
                strokeWidth={s.emphasis ? 2 : 1.5} strokeLinejoin="round" strokeLinecap="round"
              />
              {s.emphasis && s.points.map((p, i) => (p.value === null ? null : (
                <circle key={i} cx={x(i)} cy={y(p.value)} r="3.2" fill={s.color} stroke="var(--surface-1)" strokeWidth="2" />
              )))}
              {lastPoint && lastPoint.value !== null && (
                <text
                  x={x(lastIdx) + 8} y={y(lastPoint.value) + 3.5}
                  className="axis-label"
                  style={{ fill: s.emphasis ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: s.emphasis ? 650 : 400 }}
                >
                  {lastPoint.value.toFixed(2)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="legend" style={{ marginTop: 6 }}>
        {series.map((s) => (
          <span key={s.label} className="legend-item">
            <i className="legend-key" style={{ background: s.color, height: s.emphasis ? 3 : 2 }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ window labels */

export const WINDOW_LABEL: Record<string, string> = {
  prev: 'prev', d1: '1d', w1: '1w', m1: '1mo', m3: '3mo', ytd: 'YTD', y1: '1y', y5: '5y',
};

/**
 * The change window a row should lead with, chosen from its publication cadence.
 *
 * A one-day change on a monthly series is either zero or a release-day jump —
 * both misleading. Each series leads with the shortest window that contains at
 * least one genuine observation gap.
 */
export function leadWindowFor(cadence: string): 'd1' | 'w1' | 'm1' | 'm3' {
  switch (cadence) {
    case 'daily': return 'd1';
    case 'weekly': return 'w1';
    case 'monthly': return 'm1';
    default: return 'm3';
  }
}


/**
 * Three axis values rounded to a clean step.
 *
 * Ticks exist to be read off; `5.612` and `4.369` are arithmetic artefacts of
 * the data range, not numbers anybody wants on an axis.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  // `count` is the target number of *intervals*, and the 0.85 slack lets a step
  // that lands just under the ideal win — without it a range of 2.1 snaps from
  // 0.5 to 1.0 and the axis ends up with a single tick on it.
  const rough = span / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= rough * 0.85) ?? 10) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001 && out.length < count + 2; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out.length > 0 ? out : [min, max];
}
