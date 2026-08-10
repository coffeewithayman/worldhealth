/**
 * Number and date presentation.
 *
 * Kept in one file because consistency is the whole point: a figure that reads
 * `4,335.55` in the headline strip and `4.34K` in the table below it makes the
 * reader stop and reconcile two numbers that are the same number.
 */

/** Compact form for tiles and axis ticks, where space is the constraint. */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (abs >= 100) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (abs >= 1) return n.toFixed(2);
  if (abs >= 0.01) return n.toFixed(4);
  return n.toPrecision(3);
}

/**
 * Full-precision form for tables and drill-downs.
 *
 * `decimals` comes from the board definition where magnitude alone gives the
 * wrong answer — EUR/USD needs four places at a value of 1.15, while the
 * Indonesian rupiah needs none at 16,000.
 */
export function fmtValue(n: number | null | undefined, decimals?: number | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (decimals !== null && decimals !== undefined) {
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  const abs = Math.abs(n);
  if (abs >= 100_000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (abs >= 10) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(3);
  if (abs >= 0.01) return n.toFixed(4);
  return n.toPrecision(3);
}

/**
 * One end of a range, formatted by the magnitude of the *larger* end so both
 * ends of the same range always take the same form.
 */
export function fmtRangeEnd(value: number, scaleRef: number): string {
  const ref = Math.abs(scaleRef);
  if (ref >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (ref >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (ref >= 10_000) return `${(value / 1000).toFixed(1)}K`;
  if (ref >= 100) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (ref >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

export function fmtPct(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}

export function fmtSigned(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}`;
}

/** `2026-08-07` → `7 Aug 2026`. Unambiguous in every locale, unlike 8/7. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mi = Number(m) - 1;
  if (!y || !d || mi < 0 || mi > 11) return iso;
  return `${Number(d)} ${months[mi]} ${y}`;
}

/** `2026-08-07` → `7 Aug`, dropping the year inside the current one. */
export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const full = fmtDate(iso);
  const thisYear = new Date().getFullYear().toString();
  return iso.startsWith(thisYear) ? full.replace(` ${thisYear}`, '') : full;
}

/** "3 days ago" — how fresh a number is matters as much as the number. */
export function fmtAge(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return '';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 21) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

const CADENCE_LABEL: Record<string, string> = {
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly',
  quarterly: 'Quarterly', annual: 'Annual', irregular: 'Irregular',
};
export function fmtCadence(c: string | null | undefined): string {
  return c ? CADENCE_LABEL[c] ?? c : '';
}

/** Ordinal-suffixed percentile, e.g. `91st percentile`. */
export function fmtPercentile(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  const n = Math.round(p * 100);
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th'
    : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}
