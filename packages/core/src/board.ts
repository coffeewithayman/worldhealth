/**
 * The markets board — curated price panels.
 *
 * The scoring engine answers "how stressed is the system"; this answers the
 * prior question a reader actually opens with: "what do things cost right now,
 * and which way are they moving". Both read the same observation table.
 *
 * Curation lives here rather than in the API layer because the choice of what
 * belongs on a price board is a domain judgement, and because the same list is
 * used to decide what the ingest job must keep fresh.
 */

/** How to read a rise in this row. Drives the delta colour, nothing else. */
export type RiseMeaning =
  /** Rising is a healthier reading (growth, demand, liquidity). */
  | 'good'
  /** Rising is a worse reading (stress, spreads, volatility, debasement). */
  | 'bad'
  /**
   * Rising is neither. Most prices are here: an oil price is not "good" or
   * "bad" without a viewpoint, so the delta shows direction with an arrow and
   * wears neutral ink rather than borrowing a status colour it hasn't earned.
   */
  | 'neutral';

export interface BoardRow {
  seriesId: string;
  /** Short display label. Board rows are read in a column, so they must be terse. */
  label: string;
  /** One line on what the number means. Shown on the row's detail line. */
  hint?: string;
  rising?: RiseMeaning;
  /** Fixed decimal places, where magnitude alone gives the wrong answer. */
  decimals?: number;
  /**
   * Quote absolute moves in basis points.
   *
   * Curated rather than inferred from the unit, because "percent" covers both
   * yields (which move in bp) and things like unemployment or capacity
   * utilisation (which do not). Guessing gets one of the two wrong every time.
   */
  bp?: boolean;
  /**
   * A second series showing what this row's currency is worth in gold. Used by
   * the currency board: the point of the panel is that every fiat pair can look
   * calm while all of them fall together against the one thing that isn't
   * anybody's liability.
   */
  goldSeriesId?: string;
}

export interface BoardGroup {
  id: string;
  label: string;
  /** Why the panel exists and how to read it. */
  blurb: string;
  /** Which change window the board leads with. */
  lead: 'prev' | 'd1' | 'w1' | 'm1' | 'm3' | 'ytd' | 'y1';
  rows: BoardRow[];
}

/** USD pairs, with the matching gold-in-that-currency series where one exists. */
const CURRENCIES: Array<[code: string, name: string, decimals?: number]> = [
  ['JPY', 'Japanese Yen', 2], ['CNY', 'Chinese Yuan', 4], ['GBP', 'British Pound', 4],
  ['CHF', 'Swiss Franc', 4], ['CAD', 'Canadian Dollar', 4], ['AUD', 'Australian Dollar', 4],
  ['NZD', 'New Zealand Dollar', 4], ['SEK', 'Swedish Krona', 3], ['NOK', 'Norwegian Krone', 3],
  ['DKK', 'Danish Krone', 3], ['PLN', 'Polish Zloty', 3], ['CZK', 'Czech Koruna', 2],
  ['HUF', 'Hungarian Forint', 1], ['RON', 'Romanian Leu', 3], ['TRY', 'Turkish Lira', 3],
  ['INR', 'Indian Rupee', 2], ['KRW', 'South Korean Won', 1], ['SGD', 'Singapore Dollar', 4],
  ['HKD', 'Hong Kong Dollar', 4], ['IDR', 'Indonesian Rupiah', 0], ['THB', 'Thai Baht', 2],
  ['PHP', 'Philippine Peso', 2], ['ILS', 'Israeli Shekel', 3], ['MXN', 'Mexican Peso', 3],
  ['BRL', 'Brazilian Real', 3], ['ZAR', 'South African Rand', 3],
];

const GOLD_CURRENCIES = new Set([
  'JPY', 'CNY', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'PLN', 'CZK', 'HUF',
  'RON', 'TRY', 'INR', 'KRW', 'IDR', 'THB', 'PHP', 'MXN', 'BRL', 'ZAR',
]);

export const BOARD: BoardGroup[] = [
  {
    id: 'fx',
    label: 'Currencies',
    blurb:
      'Daily ECB reference rates, quoted as units of the currency per one US dollar — so a rising '
      + 'number means that currency is buying fewer dollars. The final column is the same currency '
      + 'measured against gold over a year, which is the only column that can show every fiat '
      + 'currency falling at once.',
    lead: 'd1',
    rows: [
      { seriesId: 'fx.broad_dollar', label: 'US Dollar Index (broad)', rising: 'bad', decimals: 2,
        hint: 'Trade-weighted dollar. A rising dollar tightens global financial conditions no matter what any central bank says, because most of the world’s debt is priced in it.' },
      { seriesId: 'fx.EURUSD', label: 'EUR / USD', rising: 'neutral', decimals: 4,
        hint: 'Dollars per euro — quoted the way the market quotes it, the one inverted row on this board.', goldSeriesId: 'metal.gold.eur' },
      ...CURRENCIES.map(([code, name, decimals]): BoardRow => ({
        seriesId: `fx.USD${code}`,
        label: `USD / ${code}`,
        hint: name,
        rising: 'neutral',
        decimals,
        ...(GOLD_CURRENCIES.has(code) ? { goldSeriesId: `d.gold.${code.toLowerCase()}` } : {}),
      })),
    ],
  },
  {
    id: 'precious',
    label: 'Precious metals',
    blurb:
      'LBMA benchmark fixings — the prices physical bullion actually settles at, published daily. '
      + 'Gold is the reference asset for this whole dashboard: it is the only major monetary asset '
      + 'that is nobody’s liability, so a rising gold price is a falling currency more often than '
      + 'it is a rising metal.',
    lead: 'd1',
    rows: [
      { seriesId: 'metal.gold', label: 'Gold', rising: 'bad', decimals: 2,
        hint: 'LBMA PM fix, USD per troy ounce. Rising is flagged as stress here because in this dashboard’s frame gold going up is the unit of account going down.' },
      { seriesId: 'metal.silver', label: 'Silver', rising: 'neutral', decimals: 3,
        hint: 'Half monetary metal, half industrial input — conductive paste in solar cells and chip packaging. Moves harder than gold in both directions.' },
      { seriesId: 'metal.platinum', label: 'Platinum', rising: 'neutral', decimals: 2,
        hint: 'Autocatalysts and industrial catalysis. Supply is concentrated in South Africa, so its shocks are usually electricity and mining shocks.' },
      { seriesId: 'metal.palladium', label: 'Palladium', rising: 'neutral', decimals: 2,
        hint: 'Autocatalysts and the terminations of multilayer ceramic capacitors — the components that go into every circuit board by the thousand.' },
      { seriesId: 'd.gold_silver_ratio', label: 'Gold / Silver ratio', rising: 'bad', decimals: 1,
        hint: 'Ounces of silver per ounce of gold. It rises when money flees to the more monetary of the two metals, so spikes mark fear rather than inflation.' },
      { seriesId: 'mkt.gold_vol', label: 'Gold volatility (GVZ)', rising: 'bad', decimals: 2,
        hint: 'Rising gold volatility alongside a rising gold price is monetary panic; a rising price on falling volatility is an orderly repricing.' },
      { seriesId: 'd.dow_gold', label: 'Dow / Gold ratio', rising: 'neutral', decimals: 2,
        hint: 'Ounces of gold needed to buy the Dow. One of the oldest valuation measures there is: it bottomed near 1 in 1932 and near 1 again in 1980.' },
      { seriesId: 'd.gold_breadth', label: 'Gold at 1-year highs', rising: 'bad', decimals: 0,
        hint: 'Share of tracked currencies in which gold is at or near a one-year high. Broad strength means currencies are falling; narrow strength is a single-currency story.' },
    ],
  },
  {
    id: 'chipmetals',
    label: 'Industrial & chip-input metals',
    blurb:
      'The physical input costs of the silicon supply chain: copper for interconnect and power '
      + 'delivery, tin for solder, aluminium for packaging and heat spreaders, nickel for capacitor '
      + 'electrodes, uranium and gas for the electricity a fab burns. IMF monthly benchmarks — the '
      + 'daily reference for every one of these is LME or Fastmarkets pricing, which is licensed and '
      + 'not free, so monthly is the honest ceiling for this panel.',
    lead: 'm1',
    rows: [
      { seriesId: 'cmd.copper', label: 'Copper', rising: 'neutral', decimals: 0,
        hint: 'Interconnect, power delivery, grid and motors. Copper is the metal that has to move before anything gets built or electrified.' },
      { seriesId: 'cmd.tin', label: 'Tin', rising: 'neutral', decimals: 0,
        hint: 'The solder metal — nearly every electrical joint in every device. Supply concentration in Indonesia, Myanmar and China makes it the most geopolitically fragile chip input.' },
      { seriesId: 'cmd.aluminum', label: 'Aluminium', rising: 'neutral', decimals: 0,
        hint: 'Packaging, heat spreaders and on-die interconnect. Around 40% of its cost is electricity, so it carries energy shocks into manufacturing faster than other metals.' },
      { seriesId: 'cmd.nickel', label: 'Nickel', rising: 'neutral', decimals: 0,
        hint: 'Barrier layers, capacitor electrodes, batteries and stainless steel. The 2022 LME squeeze is the reference case of a metal market breaking outright.' },
      { seriesId: 'cmd.zinc', label: 'Zinc', rising: 'neutral', decimals: 0,
        hint: 'Galvanising and die-casting — construction and vehicles. Carried for breadth: one metal moving is a supply story, all of them moving is a monetary one.' },
      { seriesId: 'cmd.lead', label: 'Lead', rising: 'neutral', decimals: 0,
        hint: 'Mostly batteries. Carried for breadth across the base-metal complex.' },
      { seriesId: 'cmd.iron_ore', label: 'Iron ore', rising: 'neutral', decimals: 2,
        hint: 'The cleanest free read on Chinese construction demand, and the first industrial commodity to break when Chinese property stalls.' },
      { seriesId: 'cmd.uranium', label: 'Uranium', rising: 'neutral', decimals: 2,
        hint: 'Fuel for the baseload that fabs and data centres run on. Structurally supply-constrained, and it repriced hard as AI power demand arrived.' },
      { seriesId: 'd.copper_gold', label: 'Copper / Gold ratio', rising: 'good', decimals: 2,
        hint: 'Growth against fear, with the commodity beta cancelled out: both are metals, only one is monetary. It falls before industrial slowdowns.' },
    ],
  },
  {
    id: 'semis',
    label: 'Semiconductor complex',
    blurb:
      'The chip cycle from four angles — what the market pays for chip makers, what fabs actually '
      + 'ship, what devices sell for at the factory gate, and what customers are ordering. Only the '
      + 'index is daily; the physical series are monthly official statistics, which is why the '
      + 'market number turns first and the volume numbers confirm.',
    lead: 'm1',
    rows: [
      { seriesId: 'semi.sox', label: 'PHLX Semiconductor (SOX)', rising: 'good', decimals: 2,
        hint: 'The daily market-priced read on the chip cycle. Semis lead the broad industrial cycle by roughly two quarters in both directions.' },
      { seriesId: 'semi.production', label: 'Semiconductor production', rising: 'good', decimals: 2,
        hint: 'Physical output of US semiconductor and component plants — volume, not revenue, so pricing games cannot flatter it.' },
      { seriesId: 'semi.new_orders', label: 'New orders — computers & electronics', rising: 'good', decimals: 0,
        hint: 'Order intake leads shipments, so this turns before production does. The cleanest free forward-looking read on electronics demand.' },
      { seriesId: 'semi.ppi', label: 'Chip producer prices', rising: 'neutral', decimals: 2,
        hint: 'Decades of steady deflation is the normal state. Sustained increases mean scarcity pricing; a sharp fall means the glut phase has begun.' },
      { seriesId: 'semi.lithium_miners', label: 'Lithium miners (battery-metal proxy)', rising: 'neutral', decimals: 2,
        hint: 'A proxy, not a price: lithium and cobalt have no free spot reference. Equity beta contaminates it, so read direction only — never the level.' },
    ],
  },
  {
    id: 'energy',
    label: 'Energy',
    blurb:
      'The physical energy the economy runs on, priced daily and inventoried weekly. Energy is the '
      + 'one input with no substitute: a supply shock here shows up in every other panel within two '
      + 'quarters.',
    lead: 'd1',
    rows: [
      { seriesId: 'oil.brent', label: 'Brent crude', rising: 'neutral', decimals: 2, hint: 'The global marginal barrel, USD per barrel.' },
      { seriesId: 'oil.wti', label: 'WTI crude', rising: 'neutral', decimals: 2, hint: 'The US benchmark, priced at Cushing, Oklahoma.' },
      { seriesId: 'd.brent_wti_spread', label: 'Brent − WTI spread', rising: 'neutral', decimals: 2,
        hint: 'The cost of getting a barrel out of the US interior. It widens when export logistics bind.' },
      { seriesId: 'gas.henry_hub', label: 'Natural gas (Henry Hub)', rising: 'neutral', decimals: 2,
        hint: 'US benchmark gas, USD per MMBtu — the marginal fuel for both electricity and fertiliser.' },
      { seriesId: 'oil.crude_stocks', label: 'US crude stocks', rising: 'good', decimals: 0,
        hint: 'Commercial inventories excluding the SPR. Falling stocks into rising demand is how a price spike starts.' },
      { seriesId: 'oil.distillate_stocks', label: 'US distillate stocks', rising: 'good', decimals: 0,
        hint: 'Diesel and heating oil — the fuel freight actually runs on. Thin distillate cover is a freight-cost shock waiting to happen.' },
      { seriesId: 'oil.spr_stocks', label: 'Strategic Petroleum Reserve', rising: 'good', decimals: 0,
        hint: 'The buffer of last resort. Once drawn down it takes years to refill, so the level is a measure of remaining optionality.' },
      { seriesId: 'oil.refinery_utilization', label: 'Refinery utilisation', rising: 'good', decimals: 1,
        hint: 'How hard refineries are running. Crude in the ground is not fuel until it has been through one of these.' },
      { seriesId: 'mkt.oil_vol', label: 'Oil volatility (OVX)', rising: 'bad', decimals: 2,
        hint: 'Options-implied crude volatility. It leads the physical disruption it is pricing.' },
    ],
  },
  {
    id: 'rates',
    label: 'Rates & credit',
    blurb:
      'The price of money, from overnight funding out to thirty years, plus what lenders charge '
      + 'borrowers who might not pay them back. Credit turns before equities in every serious '
      + 'downturn, without exception.',
    lead: 'd1',
    rows: [
      { seriesId: 'ust.yield.3m', bp: true, label: 'UST 3-month', rising: 'neutral', decimals: 2, hint: 'The front end — essentially the policy rate.' },
      { seriesId: 'ust.yield.2y', bp: true, label: 'UST 2-year', rising: 'neutral', decimals: 2, hint: 'The market’s forecast of the policy rate over the next two years.' },
      { seriesId: 'ust.yield.10y', bp: true, label: 'UST 10-year', rising: 'neutral', decimals: 2, hint: 'The world’s discount rate. Everything else is priced off it.' },
      { seriesId: 'ust.yield.30y', bp: true, label: 'UST 30-year', rising: 'neutral', decimals: 2, hint: 'The long bond — the purest read on long-run inflation and fiscal credibility.' },
      { seriesId: 'ust.spread.10y2y', bp: true, label: '10Y − 2Y spread', rising: 'neutral', decimals: 0,
        hint: 'Inversion warns; the re-steepening out of inversion is what has actually coincided with the onset of recessions.' },
      { seriesId: 'us.real_yield_10y', bp: true, label: '10Y real yield (TIPS)', rising: 'neutral', decimals: 2,
        hint: 'The true cost of money. Deeply negative is financial repression; sharply positive breaks leveraged balance sheets.' },
      { seriesId: 'us.breakeven_10y', bp: true, label: '10Y breakeven inflation', rising: 'bad', decimals: 2,
        hint: 'What the bond market expects inflation to average for a decade.' },
      { seriesId: 'us.hy_oas', bp: true, label: 'High-yield spread (OAS)', rising: 'bad', decimals: 2,
        hint: 'The single best real-time gauge of credit stress. Below 300bp is complacency; above 800bp is a credit event in progress.' },
      { seriesId: 'us.ig_oas', bp: true, label: 'Investment-grade spread', rising: 'bad', decimals: 2,
        hint: 'When stress reaches investment grade, it has stopped being a story about weak borrowers.' },
      { seriesId: 'em.sovereign_oas', bp: true, label: 'EM high-yield spread', rising: 'bad', decimals: 2,
        hint: 'Emerging-market dollar borrowers, who break first in any dollar-funding squeeze.' },
      { seriesId: 'us.sofr', bp: true, label: 'SOFR (repo)', rising: 'neutral', decimals: 2, hint: 'The overnight secured funding rate — the plumbing of the whole system.' },
      { seriesId: 'us.mortgage_30y', bp: true, label: '30-year mortgage', rising: 'bad', decimals: 2, hint: 'Where policy rates meet household affordability.' },
    ],
  },
  {
    id: 'markets',
    label: 'Equities & crypto',
    blurb:
      'Markets react more often than they lead, so this panel is confirmation rather than warning. '
      + 'The exception is volatility, which prices the tail before the index acknowledges it.',
    lead: 'd1',
    rows: [
      { seriesId: 'mkt.sp500', label: 'S&P 500', rising: 'good', decimals: 2 },
      { seriesId: 'mkt.nasdaq', label: 'NASDAQ Composite', rising: 'good', decimals: 2 },
      { seriesId: 'mkt.djia', label: 'Dow Jones Industrial', rising: 'good', decimals: 2 },
      { seriesId: 'mkt.nikkei', label: 'Nikkei 225', rising: 'good', decimals: 2,
        hint: 'Japan carries the largest carry-trade and duration exposure in the system, so a disorderly Nikkei is a global funding signal.' },
      { seriesId: 'mkt.vix', label: 'VIX', rising: 'bad', decimals: 2, hint: 'Thirty-day implied volatility on the S&P 500.' },
      { seriesId: 'd.sp500_drawdown', label: 'S&P 500 drawdown', rising: 'good', decimals: 1,
        hint: 'Percent below the trailing one-year high. Shown as a negative number, so a rise means recovery.' },
      { seriesId: 'crypto.btc', label: 'Bitcoin', rising: 'neutral', decimals: 0 },
      { seriesId: 'crypto.eth', label: 'Ethereum', rising: 'neutral', decimals: 2 },
      { seriesId: 'd.btc_gold', label: 'Bitcoin / Gold', rising: 'neutral', decimals: 2,
        hint: 'Bitcoin priced in ounces of gold — the two non-sovereign assets measured against each other, with the dollar taken out of the picture.' },
    ],
  },
];

/**
 * The small set of prices that lead the overview page.
 *
 * Deliberately short. A strip of ten is scanned; a strip of thirty is a table
 * that nobody reads, and the full boards are one click away.
 */
export const HEADLINE_ROWS: string[] = [
  'metal.gold', 'metal.silver', 'cmd.copper', 'fx.broad_dollar', 'fx.EURUSD',
  'fx.USDJPY', 'ust.yield.10y', 'us.hy_oas', 'oil.brent', 'semi.sox', 'mkt.vix', 'crypto.btc',
];

/** Maturities plotted on the Treasury curve, shortest first. */
export const CURVE_POINTS: Array<{ seriesId: string; label: string; months: number }> = [
  { seriesId: 'ust.yield.1m', label: '1M', months: 1 },
  { seriesId: 'ust.yield.3m', label: '3M', months: 3 },
  { seriesId: 'ust.yield.6m', label: '6M', months: 6 },
  { seriesId: 'ust.yield.1y', label: '1Y', months: 12 },
  { seriesId: 'ust.yield.2y', label: '2Y', months: 24 },
  { seriesId: 'ust.yield.3y', label: '3Y', months: 36 },
  { seriesId: 'ust.yield.5y', label: '5Y', months: 60 },
  { seriesId: 'ust.yield.7y', label: '7Y', months: 84 },
  { seriesId: 'ust.yield.10y', label: '10Y', months: 120 },
  { seriesId: 'ust.yield.20y', label: '20Y', months: 240 },
  { seriesId: 'ust.yield.30y', label: '30Y', months: 360 },
];

/** Every series id the board touches — used to preload observations in one pass. */
export function boardSeriesIds(): string[] {
  const ids = new Set<string>();
  for (const g of BOARD) {
    for (const r of g.rows) {
      ids.add(r.seriesId);
      if (r.goldSeriesId) ids.add(r.goldSeriesId);
    }
  }
  for (const c of CURVE_POINTS) ids.add(c.seriesId);
  return [...ids];
}
