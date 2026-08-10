export interface PillarSummary {
  pillar: string;
  score: number | null;
  coverage: number;
  indicatorCount: number;
  missingCount: number;
}

export interface WatchlistResult {
  id: string;
  name: string;
  rationale: string;
  triggered: boolean;
  severity: number;
  detail: string;
  available: boolean;
}

export interface SourceRun {
  sourceId: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'partial' | 'error' | 'skipped';
  rowsWritten: number;
  error: string | null;
}

export interface SeriesHealth {
  seriesId: string;
  lastObsDate: string | null;
  ageDays: number | null;
  stalenessBudgetDays: number;
  stale: boolean;
}

export interface Dashboard {
  asOf: string;
  composite: { score: number | null; regime: string; pillarsElevated: number; coverage: number };
  pillars: PillarSummary[];
  watchlist: WatchlistResult[];
  compositeHistory: Array<{ scoreDate: string; value: number }>;
  health: { totalSeries: number; staleSeries: number; stale: SeriesHealth[]; runs: SourceRun[] };
}

export interface Point { date: string; value: number }

export interface Change {
  abs: number;
  pct: number;
  fromValue: number;
  fromDate: string;
}

export type ChangeWindow = 'prev' | 'd1' | 'w1' | 'm1' | 'm3' | 'ytd' | 'y1' | 'y5';

export interface QuoteStats {
  last: { date: string; value: number } | null;
  ageDays: number | null;
  changes: Partial<Record<ChangeWindow, Change>>;
  pctMeaningful: boolean;
  range52w: { low: number; high: number; pos: number } | null;
  percentile5y: number | null;
  spark: Point[];
}

/** How to read a rise in this row — drives the delta colour and nothing else. */
export type RiseMeaning = 'good' | 'bad' | 'neutral';

export interface Quote extends QuoteStats {
  seriesId: string;
  label: string;
  hint: string | null;
  rising: RiseMeaning;
  decimals: number | null;
  /** Quote absolute moves in basis points rather than points. */
  bp: boolean;
  unit: string;
  cadence: string;
  sourceId: string;
  sourceUrl: string | null;
  stale: boolean;
  vsGold: { pct: number; date: string | null } | null;
}

export interface BoardGroup {
  id: string;
  label: string;
  blurb: string;
  lead: ChangeWindow;
  rows: Quote[];
}

export interface CurvePoint { seriesId: string; label: string; months: number; value: number | null }

export interface Markets {
  asOf: string;
  groups: BoardGroup[];
  headline: Quote[];
  curve: { asOf: string | null; today: CurvePoint[]; monthAgo: CurvePoint[]; yearAgo: CurvePoint[] };
}

export interface IndicatorDetail {
  seriesId: string;
  label: string;
  weight: number;
  score: number;
  rawValue: number;
  obsDate: string;
  ageDays: number;
  transform: string;
  explanation: string;
  /** Share of the pillar score this indicator is responsible for, 0-1. */
  contribution: number;
  spark: Point[];
  changes: Partial<Record<ChangeWindow, Change>>;
  pctMeaningful: boolean;
  range52w: { low: number; high: number; pos: number } | null;
  percentile5y: number | null;
  meta: {
    name: string; unit: string; cadence: string; sourceId: string;
    sourceUrl?: string; notes?: string;
  } | null;
}

export interface PillarDetail {
  pillar: string;
  score: number | null;
  coverage: number;
  missing: string[];
  indicators: IndicatorDetail[];
}

export interface SeriesDetail {
  series: {
    id: string; name: string; unit: string; cadence: string;
    sourceId: string; sourceUrl?: string; notes?: string; pillar: string | null;
  };
  health: SeriesHealth | null;
  stats: QuoteStats;
  observations: Array<{ obsDate: string; value: number }>;
}

export interface SourceInfo {
  id: string; name: string; homepage: string; cadence: string;
  requiresKey: string | null; optional: boolean; caveat: string | null;
  seriesCount: number; staleCount: number; lastRun: SourceRun | null;
}

export interface WorldEvent {
  id: string; ts: string; sourceId: string; category: string;
  headline: string; url: string; severity: number; entities?: string[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  dashboard: () => get<Dashboard>('/api/dashboard'),
  markets: () => get<Markets>('/api/markets'),
  events: (limit = 120) => get<{ events: WorldEvent[] }>(`/api/events?limit=${limit}`),
  pillar: (p: string) => get<PillarDetail>(`/api/pillar/${encodeURIComponent(p)}`),
  series: (id: string) => get<SeriesDetail>(`/api/series/${encodeURIComponent(id)}`),
  sources: () => get<{ sources: SourceInfo[] }>('/api/sources'),
};

export const EVENT_CATEGORIES: Record<string, string> = {
  cb_gold: 'Central bank gold',
  treasury_selling: 'Treasury selling',
  sovereign_default: 'Sovereign default',
  bank_failure: 'Bank failure',
  capital_controls: 'Capital controls',
  devaluation: 'Devaluation',
  auction_failure: 'Auction failure',
  emergency_policy: 'Emergency policy',
};

export const PILLAR_LABELS: Record<string, string> = {
  monetary: 'Monetary Debasement',
  sovereign: 'Sovereign Debt & Bonds',
  credit: 'Credit & Plumbing',
  realecon: 'Real Economy',
  trade: 'Physical Trade',
  energy: 'Energy',
  fx: 'FX & Reserves',
  markets: 'Markets',
  narrative: 'Narrative & Events',
};

export const PILLAR_BLURBS: Record<string, string> = {
  monetary: 'Money supply, real yields and gold — whether the unit of account is holding its value.',
  sovereign: 'Government funding: curves, auction demand and who is still buying the debt.',
  credit: 'Spreads, repo plumbing, swap lines and bank balance sheets. Credit leads every serious downturn.',
  realecon: 'Employment, production and housing — the economy people actually live in.',
  trade: 'Physical goods movement. Harder to manage than financial data, so harder to fake.',
  energy: 'Oil, distillates and grid load — the physical energy the economy runs on.',
  fx: 'Exchange rates and reserves, including de-dollarisation and EM currency stress.',
  markets: 'Equity levels and volatility. Markets react more often than they lead.',
  narrative: 'News-derived event intensity. Corroboration, never primary evidence.',
};

/**
 * Score band → status role. Bands are shared by every visual so a colour always
 * means the same thing, and each carries an icon and a label alongside it.
 */
export type Status = 'good' | 'warning' | 'serious' | 'critical' | 'unknown';

export function statusFor(score: number | null | undefined): Status {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'unknown';
  if (score >= 75) return 'critical';
  if (score >= 60) return 'serious';
  if (score >= 30) return 'warning';
  return 'good';
}

export const STATUS_COLOR: Record<Status, string> = {
  good: 'var(--status-good)',
  warning: 'var(--status-warning)',
  serious: 'var(--status-serious)',
  critical: 'var(--status-critical)',
  unknown: 'var(--status-unknown)',
};

/** Icon paired with every status colour so meaning never rests on hue alone. */
export const STATUS_ICON: Record<Status, string> = {
  good: '●',
  warning: '▲',
  serious: '▲',
  critical: '■',
  unknown: '?',
};

export function statusLabel(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'No data';
  if (score >= 75) return 'Crisis';
  if (score >= 60) return 'Severe';
  if (score >= 45) return 'Elevated';
  if (score >= 30) return 'Watchful';
  return 'Calm';
}

/** The five bands, in order, for the scale printed under the composite gauge. */
export const SCORE_BANDS: Array<{ label: string; from: number; to: number; status: Status }> = [
  { label: 'Calm', from: 0, to: 30, status: 'good' },
  { label: 'Watchful', from: 30, to: 45, status: 'warning' },
  { label: 'Elevated', from: 45, to: 60, status: 'warning' },
  { label: 'Severe', from: 60, to: 75, status: 'serious' },
  { label: 'Crisis', from: 75, to: 100, status: 'critical' },
];

export function fmtNum(n: number, unit?: string): string {
  if (!Number.isFinite(n)) return 'n/a';
  const abs = Math.abs(n);
  let s: string;
  if (abs >= 1e12) s = `${(n / 1e12).toFixed(2)}T`;
  else if (abs >= 1e9) s = `${(n / 1e9).toFixed(2)}B`;
  else if (abs >= 1e6) s = `${(n / 1e6).toFixed(2)}M`;
  else if (abs >= 1000) s = n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  else if (abs >= 1) s = n.toFixed(2);
  else s = n.toFixed(4);
  return unit ? `${s} ${unit}` : s;
}
