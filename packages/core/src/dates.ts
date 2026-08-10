import type { IsoDate } from './types.js';

const MS_PER_DAY = 86_400_000;

/** Today in UTC as `YYYY-MM-DD`. UTC throughout so local timezone never shifts a data point. */
export function todayIso(): IsoDate {
  return new Date().toISOString().slice(0, 10);
}

export function toIso(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function parseIso(s: IsoDate): Date {
  return new Date(`${s}T00:00:00Z`);
}

export function addDays(s: IsoDate, n: number): IsoDate {
  return toIso(new Date(parseIso(s).getTime() + n * MS_PER_DAY));
}

export function addYears(s: IsoDate, n: number): IsoDate {
  const d = parseIso(s);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return toIso(d);
}

/** Whole days from `a` to `b`. Negative when `b` precedes `a`. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / MS_PER_DAY);
}

export function isValidIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseIso(s).getTime());
}
