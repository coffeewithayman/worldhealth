import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { niceTicks } from './components';
import { fmtDate, fmtDateShort } from './format';

export interface Point { date: string; value: number }

interface Props {
  data: Point[];
  height?: number;
  color?: string;
  unit?: string;
  /** Horizontal reference line, e.g. the zero line on a spread. */
  refLine?: { value: number; label: string };
  /** Series name, shown in the tooltip. A single series needs no legend box. */
  name?: string;
  /** Wash beneath the line. Off for spreads, where the fill would imply an area. */
  fill?: boolean;
}

const PAD = { top: 12, right: 58, bottom: 22, left: 46 };

/**
 * Single-series time-series chart.
 *
 * Hand-rolled SVG rather than a charting library: it keeps the bundle free of
 * dependencies and gives exact control over the mark specs — 2px stroke,
 * recessive solid grid, a direct end-label instead of a legend, and a crosshair
 * tooltip. One series means no legend box is needed; the caption names it.
 */
export function LineChart({ data, height = 200, color = 'var(--series-1)', unit, refLine, name, fill = true }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  // Track container width so the chart is responsive without a resize library.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) > 2 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    if (data.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const d of data) { if (d.value < min) min = d.value; if (d.value > max) max = d.value; }
    if (refLine) { min = Math.min(min, refLine.value); max = Math.max(max, refLine.value); }
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    min -= span * 0.1;
    max += span * 0.1;

    const w = Math.max(280, width);
    const innerW = w - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;

    const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(d.value).toFixed(2)}`).join(' ');
    const area = `${line} L${x(data.length - 1).toFixed(2)},${height - PAD.bottom} L${x(0).toFixed(2)},${height - PAD.bottom} Z`;
    return { x, y, line, area, min, max, w, innerH };
  }, [data, width, height, refLine]);

  if (!geom || data.length === 0) {
    return <div ref={wrapRef} className="muted small" style={{ padding: '40px 0', textAlign: 'center' }}>No data in this range</div>;
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // The SVG stretches to the container, so map client pixels through the
    // viewBox scale rather than assuming they are the same unit.
    const scale = geom.w / rect.width;
    const rel = (e.clientX - rect.left) * scale - PAD.left;
    const innerW = geom.w - PAD.left - PAD.right;
    const i = Math.round((rel / innerW) * (data.length - 1));
    setHover({ i: Math.max(0, Math.min(data.length - 1, i)), x: e.clientX, y: e.clientY });
  };

  const last = data[data.length - 1]!;
  const hovered = hover ? data[hover.i] : null;
  const gridValues = niceTicks(geom.min, geom.max, 4);
  const gradientId = `grad-${(name ?? 'series').replace(/\W+/g, '')}`;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${geom.w} ${height}`}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${name ?? 'Series'} from ${data[0]!.date} to ${last.date}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.16" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recessive grid — present for reference, never competing with the data. */}
        {gridValues.map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={geom.w - PAD.right} y1={geom.y(v)} y2={geom.y(v)} stroke="var(--grid)" strokeWidth="1" />
            <text x={PAD.left - 7} y={geom.y(v) + 3.5} className="axis-label" textAnchor="end">{formatTick(v)}</text>
          </g>
        ))}

        {refLine && (
          <>
            <line
              x1={PAD.left} x2={geom.w - PAD.right}
              y1={geom.y(refLine.value)} y2={geom.y(refLine.value)}
              stroke="var(--text-faint)" strokeWidth="1"
            />
            <text x={geom.w - PAD.right + 5} y={geom.y(refLine.value) + 3.5} className="axis-label">
              {refLine.label}
            </text>
          </>
        )}

        {fill && <path d={geom.area} fill={`url(#${gradientId})`} />}
        <path d={geom.line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* Direct end-label rather than a legend: identity without a colour lookup. */}
        <circle cx={geom.x(data.length - 1)} cy={geom.y(last.value)} r="4" fill={color} stroke="var(--surface-1)" strokeWidth="2" />
        <text
          x={geom.w - PAD.right + 5} y={geom.y(last.value) + 3.5}
          className="axis-label" style={{ fill: 'var(--text-primary)', fontWeight: 650 }}
        >
          {formatTick(last.value)}
        </text>

        {hovered && (
          <>
            <line
              x1={geom.x(hover!.i)} x2={geom.x(hover!.i)}
              y1={PAD.top} y2={height - PAD.bottom}
              stroke="var(--border-strong)" strokeWidth="1"
            />
            <circle cx={geom.x(hover!.i)} cy={geom.y(hovered.value)} r="4.5" fill={color} stroke="var(--surface-1)" strokeWidth="2" />
          </>
        )}

        <text x={PAD.left} y={height - 5} className="axis-label">{fmtDateShort(data[0]!.date)}</text>
        <text x={geom.w - PAD.right} y={height - 5} className="axis-label" textAnchor="end">{fmtDateShort(last.date)}</text>
      </svg>

      {hovered && hover && (
        <div className="chart-tooltip" style={{ left: hover.x + 14, top: hover.y - 46 }}>
          <div className="tt-date">{fmtDate(hovered.date)}</div>
          <div className="tt-val">{formatTick(hovered.value)}{unit ? ` ${unit}` : ''}</div>
        </div>
      )}
    </div>
  );
}

function formatTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 10_000) return `${(v / 1000).toFixed(0)}k`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
