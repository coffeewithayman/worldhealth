import { XMLParser } from 'fast-xml-parser';

export const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,
  trimValues: true,
});

/** fast-xml-parser collapses single-element arrays; this restores a predictable shape. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Parse a numeric field from an upstream feed.
 *
 * Returns null rather than NaN for the many "no data" spellings these sources
 * use — FRED writes ".", Treasury leaves blanks, others send "N/A" or "null".
 * Null is filtered out upstream; NaN would silently corrupt percentile ranks.
 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[$,%\s]/g, '').replace(/,/g, '');
  if (s === '' || s === '.' || s === '-' || /^(n\/?a|null|nan)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Normalise the date spellings these feeds use into `YYYY-MM-DD`. */
export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Treasury CSVs use M/D/YYYY
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  // SDMX monthly (2026-M07) and quarterly (2026-Q3)
  const m = s.match(/^(\d{4})-M(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-01`;
  const q = s.match(/^(\d{4})-Q([1-4])$/);
  if (q) return `${q[1]}-${String((Number(q[2]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Minimal CSV parser handling quoted fields and embedded commas.
 * Several of these sources emit CSV with quoted numbers containing thousands
 * separators, which a naive split would mangle.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c === '\r') continue;
    field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

/** CSV to objects keyed by header name. */
export function csvToObjects(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}
