import type { Connector, ConnectorResult, FetchCtx, Observation, SeriesDef } from '@wd/core';
import { asArray, num, xml } from './util.js';

const DAILY_90 = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
const FULL_HISTORY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';

/**
 * Currencies we track, with why each earns its place. The EM block is the point:
 * currency crises in the periphery are the classic on-ramp to a wider
 * depression, and they show up here long before they reach US data.
 */
const TRACKED: Record<string, { name: string; note?: string }> = {
  USD: { name: 'US Dollar' },
  JPY: { name: 'Japanese Yen', note: 'Carry-trade unwind proxy' },
  GBP: { name: 'British Pound' },
  CHF: { name: 'Swiss Franc', note: 'Traditional haven bid' },
  CNY: { name: 'Chinese Yuan' },
  TRY: { name: 'Turkish Lira', note: 'Chronic debasement case study' },
  INR: { name: 'Indian Rupee' },
  BRL: { name: 'Brazilian Real' },
  ZAR: { name: 'South African Rand' },
  KRW: { name: 'South Korean Won', note: 'Global trade bellwether currency' },
  MXN: { name: 'Mexican Peso' },
  AUD: { name: 'Australian Dollar', note: 'Commodity-bloc proxy' },
  CAD: { name: 'Canadian Dollar' },
  SEK: { name: 'Swedish Krona' },
  NOK: { name: 'Norwegian Krone' },
  PLN: { name: 'Polish Zloty' },
  HUF: { name: 'Hungarian Forint' },
  IDR: { name: 'Indonesian Rupiah' },
  THB: { name: 'Thai Baht' },
  HKD: { name: 'Hong Kong Dollar' },
  SGD: { name: 'Singapore Dollar' },
  ILS: { name: 'Israeli Shekel' },
  PHP: { name: 'Philippine Peso' },
  NZD: { name: 'New Zealand Dollar' },
  CZK: { name: 'Czech Koruna' },
  RON: { name: 'Romanian Leu' },
  DKK: { name: 'Danish Krone' },
};

interface CubeDay {
  '@time'?: string;
  Cube?: Array<{ '@currency'?: string; '@rate'?: string }> | { '@currency'?: string; '@rate'?: string };
}

/**
 * ECB daily euro foreign exchange reference rates.
 *
 * Chosen as the FX backbone because it is genuinely open (no key, no
 * rate limit), published by a central bank, and has an unbroken daily series
 * back to 1999. Rates are quoted as units of currency per EUR; we also derive
 * per-USD cross rates, since almost every stress measure is dollar-denominated.
 */
export const ecbFxConnector: Connector = {
  id: 'ecb-fx',
  name: 'ECB Euro Foreign Exchange Reference Rates',
  homepage: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html',
  cadence: 'daily',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    // The 90-day file is ~50KB; the full history is ~9MB. Only reach for the
    // big one when a backfill actually needs it.
    const wantsHistory = ctx.since < isoMinusDays(ctx.today, 80);
    const url = wantsHistory ? FULL_HISTORY : DAILY_90;
    ctx.log(`fetching ${wantsHistory ? 'full history' : 'last 90 days'}`);

    const body = await ctx.http.getText(url, { cacheTtlHours: wantsHistory ? 24 * 7 : 6 });
    if (!body) throw new Error('ECB returned an empty document');

    const doc = xml.parse(body) as {
      'gesmes:Envelope'?: { Cube?: { Cube?: CubeDay[] | CubeDay } };
    };
    const days = asArray(doc['gesmes:Envelope']?.Cube?.Cube);
    if (days.length === 0) throw new Error('ECB document contained no daily cubes');

    const observations: Observation[] = [];
    const seen = new Set<string>();

    for (const day of days) {
      const date = day['@time'];
      if (!date || date < ctx.since) continue;

      // Collect the whole day first: the USD rate is needed to derive every
      // cross rate, and it is not guaranteed to appear first in the document.
      const perEur = new Map<string, number>();
      for (const rate of asArray(day.Cube)) {
        const ccy = rate['@currency'];
        const v = num(rate['@rate']);
        if (!ccy || v === null || !(ccy in TRACKED)) continue;
        perEur.set(ccy, v);
      }
      if (perEur.size === 0) continue;

      // EUR/USD itself, the world's most-watched pair.
      const usdPerEur = perEur.get('USD');
      observations.push({ seriesId: 'fx.EURUSD', obsDate: date, value: usdPerEur ?? NaN });
      seen.add('fx.EURUSD');

      for (const [ccy, perEurRate] of perEur) {
        observations.push({ seriesId: `ecb.eurfx.${ccy}`, obsDate: date, value: perEurRate });
        seen.add(`ecb.eurfx.${ccy}`);

        // Units of CCY per USD. USD itself is skipped (it would be 1.0).
        if (ccy !== 'USD' && usdPerEur) {
          observations.push({ seriesId: `fx.USD${ccy}`, obsDate: date, value: perEurRate / usdPerEur });
          seen.add(`fx.USD${ccy}`);
        }
      }
    }

    return {
      series: buildSeriesDefs(seen),
      observations: observations.filter((o) => Number.isFinite(o.value)),
    };
  },
};

function buildSeriesDefs(seen: Set<string>): SeriesDef[] {
  const defs: SeriesDef[] = [];
  const base = {
    sourceId: 'ecb-fx',
    cadence: 'daily' as const,
    // ECB publishes on TARGET business days; a long weekend plus a holiday can
    // legitimately reach 5 days without an update.
    stalenessBudgetDays: 6,
    pillar: 'fx' as const,
    sourceUrl: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
  };

  if (seen.has('fx.EURUSD')) {
    defs.push({ ...base, id: 'fx.EURUSD', name: 'EUR/USD', unit: 'USD per EUR' });
  }
  for (const [ccy, meta] of Object.entries(TRACKED)) {
    if (seen.has(`ecb.eurfx.${ccy}`)) {
      defs.push({
        ...base,
        id: `ecb.eurfx.${ccy}`,
        name: `EUR/${ccy} (${meta.name})`,
        unit: `${ccy} per EUR`,
        notes: meta.note,
      });
    }
    if (seen.has(`fx.USD${ccy}`)) {
      defs.push({
        ...base,
        id: `fx.USD${ccy}`,
        name: `USD/${ccy} (${meta.name})`,
        unit: `${ccy} per USD`,
        notes: meta.note ? `${meta.note}. Derived from ECB EUR cross rates.` : 'Derived from ECB EUR cross rates.',
      });
    }
  }
  return defs;
}

function isoMinusDays(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);
}
