import { breadthAtHighs, changeOver, combine, rollingMean, yoyPercent } from './series-math.js';
import type { Cadence, IsoDate, Observation, Pillar, SeriesDef } from './types.js';

export type SeriesLookup = (id: string) => Observation[] | undefined;

export interface Derivation {
  id: string;
  name: string;
  unit: string;
  pillar: Pillar;
  cadence: Cadence;
  stalenessBudgetDays: number;
  notes?: string;
  /** Series that must all be present. A missing input skips the derivation with a warning. */
  inputs: string[];
  /** Optional extra inputs used when available; absence is not an error. */
  optionalInputs?: string[];
  compute(get: SeriesLookup): Array<{ obsDate: IsoDate; value: number }>;
}

/** Currencies for which we compute a gold price. Mirrors the ECB connector's coverage. */
export const GOLD_CURRENCIES = [
  'JPY', 'GBP', 'CHF', 'CNY', 'TRY', 'INR', 'BRL', 'ZAR', 'KRW', 'MXN',
  'AUD', 'CAD', 'SEK', 'NOK', 'PLN', 'HUF', 'IDR', 'THB', 'PHP', 'NZD', 'CZK', 'RON',
] as const;

const req = (get: SeriesLookup, id: string): Observation[] => get(id) ?? [];

/**
 * Derived series.
 *
 * These are where raw feeds become analysis. Several of them — gold breadth
 * across currencies, curve un-inversion velocity, dealer takedown trend — are
 * the actual depression signals; the raw inputs on their own are just numbers.
 */
export const DERIVATIONS: Derivation[] = [
  // ------------------------------------------------------------ sound money
  // Gold priced in each fiat currency. The debasement league table.
  ...GOLD_CURRENCIES.map((ccy): Derivation => ({
    id: `d.gold.${ccy.toLowerCase()}`,
    name: `Gold Price in ${ccy}`,
    unit: `${ccy} per troy ounce`,
    pillar: 'monetary',
    cadence: 'daily',
    stalenessBudgetDays: 6,
    notes: `Gold measured in ${ccy}. Reading gold in many currencies at once turns a commodity chart into a currency-strength ranking.`,
    inputs: ['metal.gold', `fx.USD${ccy}`],
    compute: (get) => combine(
      req(get, 'metal.gold'),
      [req(get, `fx.USD${ccy}`)],
      (goldUsd, [rate]) => goldUsd * rate!,
    ),
  })),

  {
    id: 'd.gold_breadth',
    name: 'Gold at 1-Year Highs — Currency Breadth',
    unit: 'percent of currencies',
    pillar: 'monetary',
    cadence: 'daily',
    stalenessBudgetDays: 6,
    notes:
      'The share of tracked currencies in which gold sits at or near a one-year high. '
      + 'This is the most sound-money-native indicator in the dashboard. Gold rising against one currency is that country’s problem; '
      + 'gold rising against nearly all of them simultaneously means the fiat system as a whole is being repriced, which is a '
      + 'qualitatively different and far more serious signal.',
    inputs: ['metal.gold'],
    optionalInputs: GOLD_CURRENCIES.map((c) => `d.gold.${c.toLowerCase()}`),
    compute: (get) => {
      const list = [
        req(get, 'metal.gold'),
        ...GOLD_CURRENCIES.map((c) => req(get, `d.gold.${c.toLowerCase()}`)),
      ].filter((s) => s.length > 0);
      return breadthAtHighs(list, 365, 0.02);
    },
  },

  {
    id: 'd.gold_silver_ratio',
    name: 'Gold/Silver Ratio',
    unit: 'ounces of silver per ounce of gold',
    pillar: 'monetary',
    cadence: 'daily',
    stalenessBudgetDays: 6,
    notes: 'Silver is half industrial metal, half monetary. A rising ratio means the monetary half is winning — fear over growth.',
    inputs: ['metal.gold', 'metal.silver'],
    compute: (get) => combine(req(get, 'metal.gold'), [req(get, 'metal.silver')], (g, [s]) => g / s!),
  },

  {
    id: 'd.dow_gold',
    name: 'Dow/Gold Ratio',
    unit: 'ounces of gold to buy the Dow',
    pillar: 'monetary',
    cadence: 'daily',
    stalenessBudgetDays: 7,
    notes:
      'One of the oldest sound-money valuation measures: how many ounces of gold buy the Dow. '
      + 'It cut through to roughly 1 in 1980 and 2 in 1932 — expressing equity values in hard money strips out the debasement that nominal indices hide.',
    inputs: ['mkt.djia', 'metal.gold'],
    compute: (get) => combine(req(get, 'mkt.djia'), [req(get, 'metal.gold')], (d, [g]) => d / g!),
  },

  {
    id: 'd.sp500_gold',
    name: 'S&P 500 / Gold Ratio',
    unit: 'ounces of gold',
    pillar: 'monetary',
    cadence: 'daily',
    stalenessBudgetDays: 7,
    notes: 'The S&P priced in hard money. Nominal highs alongside a falling ratio mean the index is rising only in debased units.',
    inputs: ['mkt.sp500', 'metal.gold'],
    compute: (get) => combine(req(get, 'mkt.sp500'), [req(get, 'metal.gold')], (s, [g]) => s / g!),
  },

  {
    id: 'd.gold_oil',
    name: 'Gold/Oil Ratio',
    unit: 'barrels per ounce',
    pillar: 'monetary',
    cadence: 'daily',
    stalenessBudgetDays: 8,
    notes: 'Barrels of crude per ounce of gold. Spikes mark either an energy collapse or a monetary panic — check which alongside the energy pillar.',
    inputs: ['metal.gold', 'oil.wti'],
    compute: (get) => combine(req(get, 'metal.gold'), [req(get, 'oil.wti')], (g, [o]) => (o! > 0 ? g / o! : NaN)),
  },

  {
    id: 'd.copper_gold',
    name: 'Copper/Gold Ratio',
    unit: 'ratio (indexed)',
    pillar: 'trade',
    cadence: 'monthly',
    stalenessBudgetDays: 85,
    notes:
      'Growth versus fear in a single number: both are metals, but only gold is monetary. '
      + 'A falling copper/gold ratio has historically led declines in bond yields and industrial activity.',
    inputs: ['cmd.copper', 'metal.gold'],
    compute: (get) => combine(req(get, 'cmd.copper'), [req(get, 'metal.gold')], (c, [g]) => (c / g!) * 1000),
  },

  {
    id: 'd.btc_gold',
    name: 'Bitcoin priced in Gold',
    unit: 'troy ounces per BTC',
    pillar: 'monetary',
    cadence: 'daily',
    stalenessBudgetDays: 6,
    notes: 'Which hard asset the debasement bid is choosing. Divergence between the two says something about the holder base, not the currency.',
    inputs: ['crypto.btc', 'metal.gold'],
    compute: (get) => combine(req(get, 'crypto.btc'), [req(get, 'metal.gold')], (b, [g]) => b / g!),
  },

  {
    id: 'd.m2_yoy',
    name: 'M2 Money Supply — Year-over-Year',
    unit: 'percent',
    pillar: 'monetary',
    cadence: 'monthly',
    stalenessBudgetDays: 85,
    notes:
      'Outright M2 contraction is extraordinarily rare — it has happened in the 1930s and in 2023, and essentially nowhere else. '
      + 'A negative reading is one of the strongest depression-distinct signals available, as opposed to merely recessionary.',
    inputs: ['us.m2'],
    compute: (get) => yoyPercent(req(get, 'us.m2')),
  },

  {
    id: 'd.fed_assets_yoy',
    name: 'Fed Balance Sheet — Year-over-Year',
    unit: 'percent',
    pillar: 'monetary',
    cadence: 'weekly',
    stalenessBudgetDays: 14,
    inputs: ['us.fed_assets'],
    compute: (get) => yoyPercent(req(get, 'us.fed_assets')),
  },

  // -------------------------------------------------------------- sovereign
  {
    id: 'd.interest_to_receipts',
    name: 'Federal Interest Expense / Receipts',
    unit: 'percent',
    pillar: 'sovereign',
    cadence: 'quarterly',
    stalenessBudgetDays: 265,
    notes:
      'The fiscal-dominance ratio. Once debt service consumes a large enough share of revenue, monetary policy stops being '
      + 'independent — the central bank must keep rates low to keep the sovereign solvent, whatever inflation is doing. '
      + 'This is the mechanism by which a debt problem becomes a currency problem.',
    inputs: ['us.federal_interest', 'us.federal_receipts'],
    compute: (get) => combine(
      req(get, 'us.federal_interest'),
      [req(get, 'us.federal_receipts')],
      (interest, [receipts]) => (receipts! > 0 ? (interest / receipts!) * 100 : NaN),
    ),
  },

  {
    id: 'd.curve_steepening_90d',
    name: '10Y-2Y Curve — 90-Day Change',
    unit: 'basis points',
    pillar: 'sovereign',
    cadence: 'daily',
    stalenessBudgetDays: 6,
    notes:
      'Rapid re-steepening is the actual recession trigger, not the inversion itself. '
      + 'Curves invert for a year or more without incident, then bull-steepen sharply as the market prices in emergency cuts — '
      + 'and that is when the downturn arrives. Most dashboards watch the level and miss this entirely.',
    inputs: ['ust.spread.10y2y'],
    compute: (get) => changeOver(req(get, 'ust.spread.10y2y'), 90),
  },

  {
    id: 'd.auction_dealer_avg',
    name: 'Coupon Auction Dealer Takedown — 180-Day Average',
    unit: 'percent of accepted',
    pillar: 'sovereign',
    cadence: 'irregular',
    stalenessBudgetDays: 45,
    notes:
      'Smoothed across auctions, because any single auction is noisy. A sustained rise means primary dealers are absorbing '
      + 'more of each sale because genuine buyers are stepping back — the quantitative early form of a failed auction.',
    inputs: ['ust.auction.dealer.coupon'],
    compute: (get) => rollingMean(req(get, 'ust.auction.dealer.coupon'), 180),
  },

  {
    id: 'd.auction_btc_avg',
    name: 'Coupon Auction Bid-to-Cover — 180-Day Average',
    unit: 'ratio',
    pillar: 'sovereign',
    cadence: 'irregular',
    stalenessBudgetDays: 45,
    notes: 'Falling smoothed bid-to-cover indicates deteriorating demand for government debt.',
    inputs: ['ust.auction.btc.coupon'],
    compute: (get) => rollingMean(req(get, 'ust.auction.btc.coupon'), 180),
  },

  {
    id: 'd.auction_indirect_avg',
    name: 'Coupon Auction Indirect Share — 180-Day Average',
    unit: 'percent of accepted',
    pillar: 'sovereign',
    cadence: 'irregular',
    stalenessBudgetDays: 45,
    notes: 'Indirect bidders are largely foreign official accounts. A sustained decline is de-dollarisation showing up in the primary market.',
    inputs: ['ust.auction.indirect.coupon'],
    compute: (get) => rollingMean(req(get, 'ust.auction.indirect.coupon'), 180),
  },

  // ----------------------------------------------------------------- credit
  {
    id: 'd.sofr_iorb',
    name: 'SOFR minus IORB',
    unit: 'basis points',
    pillar: 'credit',
    cadence: 'daily',
    stalenessBudgetDays: 6,
    notes:
      'Repo trading persistently above the rate the Fed pays on reserves means collateral markets are short of cash. '
      + 'This spread blew out days before the September 2019 repo crisis and is the earliest plumbing-level warning available.',
    inputs: ['us.sofr', 'us.iorb'],
    compute: (get) => combine(req(get, 'us.sofr'), [req(get, 'us.iorb')], (sofr, [iorb]) => (sofr - iorb!) * 100),
  },

  {
    id: 'd.bank_credit_yoy',
    name: 'Bank Credit — Year-over-Year',
    unit: 'percent',
    pillar: 'credit',
    cadence: 'weekly',
    stalenessBudgetDays: 16,
    notes:
      'Contracting bank credit is the transmission mechanism that turns a financial shock into a depression. '
      + 'In a credit-based monetary system, shrinking bank balance sheets destroy money directly.',
    inputs: ['us.bank_credit'],
    compute: (get) => yoyPercent(req(get, 'us.bank_credit')),
  },

  {
    id: 'd.deposits_yoy',
    name: 'Commercial Bank Deposits — Year-over-Year',
    unit: 'percent',
    pillar: 'credit',
    cadence: 'weekly',
    stalenessBudgetDays: 16,
    notes: 'Deposit flight forces asset sales at whatever price the market offers. This is a bank run measured in aggregate.',
    inputs: ['us.bank_deposits'],
    compute: (get) => yoyPercent(req(get, 'us.bank_deposits')),
  },

  {
    id: 'd.vix_term_structure',
    name: 'VIX / VIX3M Term Structure',
    unit: 'ratio',
    pillar: 'markets',
    cadence: 'daily',
    stalenessBudgetDays: 6,
    notes:
      'Above 1.0 the curve is inverted: the market fears the next month more than the next quarter. '
      + 'Inversion identifies acute stress earlier and with fewer false positives than the VIX level alone.',
    inputs: ['mkt.vix', 'mkt.vix3m'],
    compute: (get) => combine(req(get, 'mkt.vix'), [req(get, 'mkt.vix3m')], (v, [v3]) => v / v3!),
  },

  {
    id: 'd.claims_yoy',
    name: 'Initial Jobless Claims — Year-over-Year',
    unit: 'percent',
    pillar: 'realecon',
    cadence: 'weekly',
    stalenessBudgetDays: 16,
    notes: 'Claims are noisy week to week; the year-over-year rate strips out seasonality and shows the trend.',
    inputs: ['us.initial_claims'],
    compute: (get) => yoyPercent(req(get, 'us.initial_claims')),
  },

  // ----------------------------------------------------------------- energy
  {
    id: 'd.chokepoint_volume',
    name: 'Global Chokepoint Transit Volume',
    unit: 'deadweight tonnes per day (7-day mean)',
    pillar: 'trade',
    cadence: 'daily',
    stalenessBudgetDays: 14,
    notes:
      'Total daily tonnage transiting the world’s major maritime chokepoints, smoothed over a week. '
      + 'A direct physical measure of world trade that no statistical agency mediates.',
    inputs: ['trade.chokepoint.suez.capacity'],
    optionalInputs: [
      'trade.chokepoint.hormuz.capacity', 'trade.chokepoint.malacca.capacity',
      'trade.chokepoint.panama.capacity', 'trade.chokepoint.bab_el_mandeb.capacity',
      'trade.chokepoint.gibraltar.capacity', 'trade.chokepoint.dover.capacity',
      'trade.chokepoint.good_hope.capacity', 'trade.chokepoint.korea.capacity',
      'trade.chokepoint.taiwan_strait.capacity', 'trade.chokepoint.bosporus.capacity',
    ],
    compute: (get) => {
      const ids = [
        'trade.chokepoint.suez.capacity', 'trade.chokepoint.hormuz.capacity',
        'trade.chokepoint.malacca.capacity', 'trade.chokepoint.panama.capacity',
        'trade.chokepoint.bab_el_mandeb.capacity', 'trade.chokepoint.gibraltar.capacity',
        'trade.chokepoint.dover.capacity', 'trade.chokepoint.good_hope.capacity',
        'trade.chokepoint.korea.capacity', 'trade.chokepoint.taiwan_strait.capacity',
        'trade.chokepoint.bosporus.capacity',
      ];
      const present = ids.map((id) => req(get, id)).filter((s) => s.length > 0);
      if (present.length === 0) return [];
      // Sum across chokepoints on the primary's date grid, then smooth: daily
      // transit counts are extremely noisy (weather, weekends, holidays).
      const primary = present[0]!;
      const summed = combine(primary, present.slice(1), (v, rest) => v + rest.reduce((a, b) => a + b, 0));
      return rollingMean(
        summed.map((p) => ({ seriesId: 'tmp', obsDate: p.obsDate, value: p.value })),
        7,
      );
    },
  },

  {
    id: 'd.chokepoint_volume_yoy',
    name: 'Global Chokepoint Volume — Year-over-Year',
    unit: 'percent',
    pillar: 'trade',
    cadence: 'daily',
    stalenessBudgetDays: 14,
    notes:
      'The year-over-year change is what matters: seaborne trade is strongly seasonal, so only an annual '
      + 'comparison separates a genuine contraction from the usual calendar pattern. Sustained negative readings '
      + 'mean the physical economy is shrinking, whatever financial markets say.',
    inputs: ['d.chokepoint_volume'],
    compute: (get) => yoyPercent(req(get, 'd.chokepoint_volume')),
  },

  {
    id: 'd.suez_rerouting',
    name: 'Cape of Good Hope / Suez Transit Ratio',
    unit: 'ratio',
    pillar: 'trade',
    cadence: 'daily',
    stalenessBudgetDays: 14,
    notes:
      'Separates rerouting from collapse — the distinction a single chokepoint cannot make. '
      + 'When Red Sea attacks closed Suez in early 2024 this ratio roughly tripled while total tonnage held up, '
      + 'showing ships were sailing around Africa rather than staying in port. A fall in Suez traffic WITHOUT a '
      + 'rise here would mean the cargo simply stopped moving, which is the genuinely alarming case.',
    inputs: ['trade.chokepoint.good_hope.transits', 'trade.chokepoint.suez.transits'],
    compute: (get) => rollingMean(
      combine(
        req(get, 'trade.chokepoint.good_hope.transits'),
        [req(get, 'trade.chokepoint.suez.transits')],
        (cape, [suez]) => (suez! > 0 ? cape / suez! : NaN),
      ).map((p) => ({ seriesId: 'tmp', obsDate: p.obsDate, value: p.value })),
      14,
    ),
  },

  {
    id: 'd.indpro_yoy',
    name: 'Industrial Production — Year-over-Year',
    unit: 'percent',
    pillar: 'realecon',
    cadence: 'monthly',
    stalenessBudgetDays: 85,
    notes: 'Negative industrial production growth outside a supply shock is a hallmark of genuine contraction.',
    inputs: ['us.industrial_production'],
    compute: (get) => yoyPercent(req(get, 'us.industrial_production')),
  },

  {
    id: 'd.retail_sales_yoy',
    name: 'Retail Sales — Year-over-Year',
    unit: 'percent',
    pillar: 'realecon',
    cadence: 'monthly',
    stalenessBudgetDays: 85,
    notes: 'Nominal, so it must be read against CPI — positive nominal growth below inflation is a real decline.',
    inputs: ['us.retail_sales'],
    compute: (get) => yoyPercent(req(get, 'us.retail_sales')),
  },

  {
    id: 'd.electricity_demand_yoy',
    name: 'US Electricity Demand — Year-over-Year',
    unit: 'percent',
    pillar: 'realecon',
    cadence: 'daily',
    stalenessBudgetDays: 8,
    notes:
      'Compared year-over-year to cancel out seasonality, since raw grid load is dominated by weather. '
      + 'Unrevised and same-week, which makes it the least laggy real-activity measure available anywhere.',
    inputs: ['us.electricity_demand'],
    compute: (get) => rollingMean(yoyPercent(req(get, 'us.electricity_demand')).map(
      (p) => ({ seriesId: 'tmp', obsDate: p.obsDate, value: p.value }),
    ), 28),
  },

  {
    id: 'd.sp500_drawdown',
    name: 'S&P 500 Drawdown from 1-Year High',
    unit: 'percent',
    pillar: 'markets',
    cadence: 'daily',
    stalenessBudgetDays: 6,
    notes: 'Distance below the trailing one-year peak. Expressed as a positive number, so larger means a deeper drawdown.',
    inputs: ['mkt.sp500'],
    compute: (get) => drawdownFromHigh(req(get, 'mkt.sp500'), 365),
  },

  {
    id: 'd.em_fx_breadth',
    name: 'EM Currencies at 1-Year Lows vs USD',
    unit: 'percent of currencies',
    pillar: 'fx',
    cadence: 'daily',
    stalenessBudgetDays: 7,
    notes:
      'Share of emerging-market currencies at or near a one-year low against the dollar. Broad EM currency weakness is the '
      + 'classic on-ramp to a wider crisis: it forces defensive rate hikes into a slowdown and makes dollar debt unpayable.',
    inputs: ['fx.USDTRY'],
    optionalInputs: ['fx.USDBRL', 'fx.USDZAR', 'fx.USDMXN', 'fx.USDIDR', 'fx.USDINR', 'fx.USDPHP', 'fx.USDTHB', 'fx.USDHUF', 'fx.USDPLN'],
    compute: (get) => {
      // Each series is CCY per USD, so a currency weakening means the series rises.
      const ids = ['fx.USDTRY', 'fx.USDBRL', 'fx.USDZAR', 'fx.USDMXN', 'fx.USDIDR',
        'fx.USDINR', 'fx.USDPHP', 'fx.USDTHB', 'fx.USDHUF', 'fx.USDPLN'];
      const list = ids.map((id) => req(get, id)).filter((s) => s.length > 0);
      return breadthAtHighs(list, 365, 0.02);
    },
  },

  {
    id: 'd.distillate_cover',
    name: 'Distillate Days of Cover',
    unit: 'days',
    pillar: 'energy',
    cadence: 'weekly',
    stalenessBudgetDays: 14,
    notes:
      'Distillate stocks divided by total product supplied. Diesel physically moves freight, agriculture and construction, '
      + 'so thin cover is a fragility the crude price does not show: the system loses its buffer against any disruption.',
    inputs: ['oil.distillate_stocks', 'oil.product_supplied'],
    compute: (get) => combine(
      req(get, 'oil.distillate_stocks'),
      [req(get, 'oil.product_supplied')],
      (stocks, [supplied]) => (supplied! > 0 ? stocks / supplied! : NaN),
    ),
  },

  {
    id: 'd.brent_wti_spread',
    name: 'Brent minus WTI',
    unit: 'USD per barrel',
    pillar: 'energy',
    cadence: 'daily',
    stalenessBudgetDays: 8,
    notes: 'A widening spread indicates dislocation between waterborne and landlocked crude — usually logistics or geopolitics rather than demand.',
    inputs: ['oil.brent', 'oil.wti'],
    compute: (get) => combine(req(get, 'oil.brent'), [req(get, 'oil.wti')], (b, [w]) => b - w!),
  },
];

/** Percent below the trailing-window maximum, expressed as a positive number. */
function drawdownFromHigh(obs: Observation[], windowDays: number): Array<{ obsDate: IsoDate; value: number }> {
  const sorted = [...obs].sort((a, b) => (a.obsDate < b.obsDate ? -1 : 1));
  const out: Array<{ obsDate: IsoDate; value: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const end = sorted[i]!.obsDate;
    const start = new Date(Date.parse(`${end}T00:00:00Z`) - windowDays * 86_400_000).toISOString().slice(0, 10);
    let max = -Infinity;
    for (let j = i; j >= 0; j--) {
      if (sorted[j]!.obsDate < start) break;
      if (sorted[j]!.value > max) max = sorted[j]!.value;
    }
    if (max > 0) out.push({ obsDate: end, value: ((max - sorted[i]!.value) / max) * 100 });
  }
  return out;
}

export function derivationToSeriesDef(d: Derivation): SeriesDef {
  return {
    id: d.id,
    name: d.name,
    unit: d.unit,
    cadence: d.cadence,
    sourceId: 'derived',
    pillar: d.pillar,
    notes: d.notes,
    stalenessBudgetDays: d.stalenessBudgetDays,
  };
}
