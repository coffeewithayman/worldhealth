import type { Cadence, Connector, ConnectorResult, FetchCtx, Observation, Pillar, SeriesDef } from '@wd/core';
import { num } from './util.js';

interface FredSeries {
  /** FRED series id, e.g. `M2SL`. */
  fred: string;
  /** Our series id. */
  id: string;
  name: string;
  unit: string;
  cadence: Cadence;
  pillar: Pillar;
  stalenessBudgetDays: number;
  notes?: string;
}

/**
 * The FRED catalogue.
 *
 * FRED is the single highest-leverage source here: one free key unlocks a large
 * fraction of the dashboard's indicators, already cleaned and revision-tracked.
 *
 * Staleness budgets are set from *publication lag*, not cadence. Quarterly bank
 * delinquency data lands roughly 70 days after quarter-end, so a 30-day budget
 * would flag healthy data as broken every single quarter.
 */
const CATALOG: FredSeries[] = [
  // ---------------------------------------------------------------- monetary
  { fred: 'M2SL', id: 'us.m2', name: 'M2 Money Stock', unit: 'billions USD', cadence: 'monthly', pillar: 'monetary', stalenessBudgetDays: 80,
    notes: 'Year-over-year contraction in M2 has happened only in the 1930s and 2023. A core depression precursor.' },
  { fred: 'BOGMBASE', id: 'us.monetary_base', name: 'Monetary Base', unit: 'billions USD', cadence: 'monthly', pillar: 'monetary', stalenessBudgetDays: 80 },
  { fred: 'WRESBAL', id: 'us.bank_reserves', name: 'Reserve Balances at Federal Reserve Banks', unit: 'billions USD', cadence: 'weekly', pillar: 'monetary', stalenessBudgetDays: 12,
    notes: 'When reserves drain toward scarcity, repo markets break first.' },
  { fred: 'WALCL', id: 'us.fed_assets', name: 'Fed Total Assets', unit: 'millions USD', cadence: 'weekly', pillar: 'monetary', stalenessBudgetDays: 12 },
  { fred: 'M2V', id: 'us.m2_velocity', name: 'M2 Velocity', unit: 'ratio', cadence: 'quarterly', pillar: 'monetary', stalenessBudgetDays: 260 },
  { fred: 'DFII10', id: 'us.real_yield_10y', name: '10-Year TIPS Real Yield', unit: 'percent', cadence: 'daily', pillar: 'monetary', stalenessBudgetDays: 5,
    notes: 'The true cost of money. Deeply negative real yields are financial repression; sharply positive breaks leveraged systems.' },
  { fred: 'DFII5', id: 'us.real_yield_5y', name: '5-Year TIPS Real Yield', unit: 'percent', cadence: 'daily', pillar: 'monetary', stalenessBudgetDays: 5 },
  { fred: 'T10YIE', id: 'us.breakeven_10y', name: '10-Year Breakeven Inflation', unit: 'percent', cadence: 'daily', pillar: 'monetary', stalenessBudgetDays: 5 },
  { fred: 'T5YIFR', id: 'us.forward_inflation_5y5y', name: '5y5y Forward Inflation Expectation', unit: 'percent', cadence: 'daily', pillar: 'monetary', stalenessBudgetDays: 5,
    notes: 'The market’s read on whether the central bank has lost control of the price level.' },
  { fred: 'CPIAUCSL', id: 'us.cpi', name: 'CPI All Urban Consumers', unit: 'index', cadence: 'monthly', pillar: 'monetary', stalenessBudgetDays: 80 },
  { fred: 'PCEPILFE', id: 'us.core_pce', name: 'Core PCE Price Index', unit: 'index', cadence: 'monthly', pillar: 'monetary', stalenessBudgetDays: 80 },
  { fred: 'CORESTICKM159SFRBATL', id: 'us.sticky_cpi', name: 'Sticky Price CPI (Atlanta Fed)', unit: 'percent YoY', cadence: 'monthly', pillar: 'monetary', stalenessBudgetDays: 80 },
  { fred: 'RRPONTSYD', id: 'us.reverse_repo', name: 'Overnight Reverse Repurchase Agreements', unit: 'billions USD', cadence: 'daily', pillar: 'monetary', stalenessBudgetDays: 5,
    notes: 'The drain of the RRP facility marks the transition from excess to scarce liquidity.' },
  { fred: 'WTREGEN', id: 'us.treasury_general_account', name: 'Treasury General Account', unit: 'billions USD', cadence: 'weekly', pillar: 'monetary', stalenessBudgetDays: 12 },

  // --------------------------------------------------------------- sovereign
  // FRED carries no true EM *sovereign* OAS — the sovereign benchmark (EMBI) is
  // JPMorgan proprietary — so this is the high-yield EM corporate spread, which
  // is the closest freely available proxy. Named for what it actually measures.
  { fred: 'BAMLEMHBHYCRPIOAS', id: 'em.sovereign_oas', name: 'Emerging Market High Yield Corporate OAS', unit: 'percent', cadence: 'daily', pillar: 'sovereign', stalenessBudgetDays: 6,
    notes: 'Proxy for EM sovereign stress: FRED has no free sovereign OAS series. EM corporates are dollar-funded, so this widens with the same dollar-funding squeeze that breaks sovereigns — but it is corporate credit, not sovereign.' },
  { fred: 'GFDEBTN', id: 'us.federal_debt', name: 'Federal Debt: Total Public Debt', unit: 'millions USD', cadence: 'quarterly', pillar: 'sovereign', stalenessBudgetDays: 260 },
  { fred: 'A091RC1Q027SBEA', id: 'us.federal_interest', name: 'Federal Government Interest Payments', unit: 'billions USD SAAR', cadence: 'quarterly', pillar: 'sovereign', stalenessBudgetDays: 260,
    notes: 'Against receipts, this is the fiscal-dominance ratio: the point where debt service crowds out policy.' },
  { fred: 'FGRECPT', id: 'us.federal_receipts', name: 'Federal Government Current Receipts', unit: 'billions USD SAAR', cadence: 'quarterly', pillar: 'sovereign', stalenessBudgetDays: 260 },
  { fred: 'DGS10', id: 'us.dgs10', name: '10-Year Treasury Constant Maturity Yield', unit: 'percent', cadence: 'daily', pillar: 'sovereign', stalenessBudgetDays: 6 },
  { fred: 'T10Y2Y', id: 'us.t10y2y_long', name: '10Y-2Y Treasury Spread (long history)', unit: 'percent', cadence: 'daily', pillar: 'sovereign', stalenessBudgetDays: 6,
    notes: 'Same measure as the Treasury-derived spread but back to 1976, covering four extra cycles. Kept as an independent cross-check and for deeper percentile baselines.' },
  { fred: 'T10Y3M', id: 'us.t10y3m_long', name: '10Y-3M Treasury Spread (long history)', unit: 'percent', cadence: 'daily', pillar: 'sovereign', stalenessBudgetDays: 6 },
  // The pressure-relief valve on foreign Treasury selling. A foreign central bank
  // that needs dollars can either sell Treasuries outright — pushing US yields up —
  // or pledge them here and borrow. Usage is therefore the early, quiet form of the
  // same stress that TIC reports as a holdings drop six weeks later.
  //
  // Zero in 93% of weeks since the facility opened in March 2020, so this is scored
  // with `bands`, not percentiles: a percentile rank against a mostly-zero history
  // is meaningless. Its one real firing was March 2023, peaking at $60bn during the
  // SVB / Credit Suisse week.
  { fred: 'H41RESPPALGTRFNWW', id: 'us.fima_repo', name: 'FIMA Repo Facility Usage', unit: 'millions USD', cadence: 'weekly', pillar: 'sovereign', stalenessBudgetDays: 12,
    notes: 'Fed lending dollars to foreign central banks against Treasury collateral. Any nonzero reading means a foreign official holder chose to borrow rather than sell Treasuries; a large one means it could not raise dollars elsewhere.' },

  // ------------------------------------------------------------------ credit
  { fred: 'BAMLH0A0HYM2', id: 'us.hy_oas', name: 'US High Yield Option-Adjusted Spread', unit: 'percent', cadence: 'daily', pillar: 'credit', stalenessBudgetDays: 6,
    notes: 'The single best real-time gauge of credit stress. Credit leads equities into every serious downturn.' },
  { fred: 'BAMLC0A0CM', id: 'us.ig_oas', name: 'US Investment Grade OAS', unit: 'percent', cadence: 'daily', pillar: 'credit', stalenessBudgetDays: 6 },
  { fred: 'BAMLH0A3HYC', id: 'us.ccc_oas', name: 'US CCC & Lower OAS', unit: 'percent', cadence: 'daily', pillar: 'credit', stalenessBudgetDays: 6,
    notes: 'The most fragile tier of corporate credit; moves before the broader index.' },
  { fred: 'SOFR', id: 'us.sofr', name: 'Secured Overnight Financing Rate', unit: 'percent', cadence: 'daily', pillar: 'credit', stalenessBudgetDays: 5 },
  { fred: 'SOFR99', id: 'us.sofr_p99', name: 'SOFR 99th Percentile', unit: 'percent', cadence: 'daily', pillar: 'credit', stalenessBudgetDays: 5,
    notes: 'The tail of repo. Spikes here are the earliest visible sign of funding stress.' },
  { fred: 'EFFR', id: 'us.effr', name: 'Effective Federal Funds Rate', unit: 'percent', cadence: 'daily', pillar: 'credit', stalenessBudgetDays: 5 },
  { fred: 'IORB', id: 'us.iorb', name: 'Interest on Reserve Balances', unit: 'percent', cadence: 'daily', pillar: 'credit', stalenessBudgetDays: 5 },
  { fred: 'NFCI', id: 'us.nfci', name: 'Chicago Fed National Financial Conditions Index', unit: 'index', cadence: 'weekly', pillar: 'credit', stalenessBudgetDays: 12 },
  { fred: 'ANFCI', id: 'us.anfci', name: 'Adjusted National Financial Conditions Index', unit: 'index', cadence: 'weekly', pillar: 'credit', stalenessBudgetDays: 12 },
  { fred: 'STLFSI4', id: 'us.stl_financial_stress', name: 'St. Louis Fed Financial Stress Index', unit: 'index', cadence: 'weekly', pillar: 'credit', stalenessBudgetDays: 12 },
  { fred: 'TOTBKCR', id: 'us.bank_credit', name: 'Bank Credit, All Commercial Banks', unit: 'billions USD', cadence: 'weekly', pillar: 'credit', stalenessBudgetDays: 21,
    notes: 'Contracting bank credit is how a credit event becomes a depression. Watch the YoY rate.' },
  { fred: 'BUSLOANS', id: 'us.ci_loans', name: 'Commercial & Industrial Loans', unit: 'billions USD', cadence: 'monthly', pillar: 'credit', stalenessBudgetDays: 80 },
  { fred: 'DPSACBW027SBOG', id: 'us.bank_deposits', name: 'Deposits, All Commercial Banks', unit: 'billions USD', cadence: 'weekly', pillar: 'credit', stalenessBudgetDays: 21,
    notes: 'Falling deposits force asset sales; this is the mechanical core of a bank run.' },
  { fred: 'DRCCLACBS', id: 'us.delinq_creditcard', name: 'Credit Card Delinquency Rate', unit: 'percent', cadence: 'quarterly', pillar: 'credit', stalenessBudgetDays: 260 },
  { fred: 'DRCRELEXFACBS', id: 'us.delinq_cre', name: 'Commercial Real Estate Delinquency Rate', unit: 'percent', cadence: 'quarterly', pillar: 'credit', stalenessBudgetDays: 260,
    notes: 'CRE is the most likely trigger for the next regional banking failure wave.' },
  { fred: 'DRSFRMACBS', id: 'us.delinq_mortgage', name: 'Residential Mortgage Delinquency Rate', unit: 'percent', cadence: 'quarterly', pillar: 'credit', stalenessBudgetDays: 260 },
  { fred: 'SWPT', id: 'us.cb_liquidity_swaps', name: 'Central Bank Liquidity Swaps', unit: 'millions USD', cadence: 'weekly', pillar: 'credit', stalenessBudgetDays: 12,
    notes: 'Near zero in calm times. Went from nothing to hundreds of billions within days in both 2008 and 2020. The cleanest global dollar-shortage alarm that exists.' },
  { fred: 'WLCFLPCL', id: 'us.discount_window', name: 'Discount Window Primary Credit', unit: 'millions USD', cadence: 'weekly', pillar: 'credit', stalenessBudgetDays: 12,
    notes: 'Banks avoid the stigma of borrowing here until they have no choice.' },
  { fred: 'BAA10Y', id: 'us.baa_spread', name: 'Moody\'s Baa Corporate Minus 10-Year Treasury', unit: 'percent', cadence: 'daily', pillar: 'credit', stalenessBudgetDays: 6,
    notes: 'History back to 1986, far deeper than the high-yield OAS series. That depth is what makes percentile scoring across multiple cycles possible.' },
  { fred: 'AAA10Y', id: 'us.aaa_spread', name: 'Moody\'s Aaa Corporate Minus 10-Year Treasury', unit: 'percent', cadence: 'daily', pillar: 'credit', stalenessBudgetDays: 6 },
  { fred: 'DRTSCILM', id: 'us.lending_standards_ci', name: 'Net % of Banks Tightening C&I Lending Standards', unit: 'percent', cadence: 'quarterly', pillar: 'credit', stalenessBudgetDays: 230,
    notes: 'From the Senior Loan Officer Survey. Banks tightening into a slowdown is the mechanism that turns a downturn into a credit crunch.' },
  { fred: 'NPTLTL', id: 'us.nonperforming_loans', name: 'Nonperforming Loans to Total Loans', unit: 'percent', cadence: 'quarterly', pillar: 'credit', stalenessBudgetDays: 230 },
  { fred: 'CORBLACBS', id: 'us.charge_off_rate', name: 'Charge-Off Rate on Business Loans', unit: 'percent', cadence: 'quarterly', pillar: 'credit', stalenessBudgetDays: 230 },
  { fred: 'KCFSI', id: 'us.kc_financial_stress', name: 'Kansas City Financial Stress Index', unit: 'index', cadence: 'monthly', pillar: 'credit', stalenessBudgetDays: 80 },

  // ---------------------------------------------------------------- realecon
  { fred: 'SAHMREALTIME', id: 'us.sahm_rule', name: 'Sahm Rule Recession Indicator (Real-Time)', unit: 'percentage points', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80,
    notes: 'Triggers at 0.50. Has identified every US recession since 1970 with no false positives.' },
  { fred: 'ICSA', id: 'us.initial_claims', name: 'Initial Jobless Claims', unit: 'persons', cadence: 'weekly', pillar: 'realecon', stalenessBudgetDays: 12,
    notes: 'The highest-frequency labour signal available, and barely revised.' },
  { fred: 'CCSA', id: 'us.continuing_claims', name: 'Continuing Jobless Claims', unit: 'persons', cadence: 'weekly', pillar: 'realecon', stalenessBudgetDays: 20,
    notes: 'Rising continuing claims mean the newly unemployed are no longer finding work.' },
  { fred: 'UNRATE', id: 'us.unemployment', name: 'Unemployment Rate', unit: 'percent', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'U6RATE', id: 'us.u6', name: 'U-6 Underemployment Rate', unit: 'percent', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'PAYEMS', id: 'us.nonfarm_payrolls', name: 'Total Nonfarm Payrolls', unit: 'thousands', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'INDPRO', id: 'us.industrial_production', name: 'Industrial Production Index', unit: 'index', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'TCU', id: 'us.capacity_utilization', name: 'Capacity Utilization', unit: 'percent', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'RSAFS', id: 'us.retail_sales', name: 'Advance Retail Sales', unit: 'millions USD', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'HTRUCKSSAAR', id: 'us.heavy_truck_sales', name: 'Heavy Weight Truck Sales', unit: 'millions SAAR', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80,
    notes: 'An unglamorous but reliable pre-recession tell: fleet buyers cut orders before layoffs show up anywhere else.' },
  { fred: 'HOUST', id: 'us.housing_starts', name: 'Housing Starts', unit: 'thousands SAAR', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'PERMIT', id: 'us.building_permits', name: 'Building Permits', unit: 'thousands SAAR', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'MORTGAGE30US', id: 'us.mortgage_30y', name: '30-Year Fixed Mortgage Rate', unit: 'percent', cadence: 'weekly', pillar: 'realecon', stalenessBudgetDays: 12 },
  { fred: 'CSUSHPINSA', id: 'us.case_shiller', name: 'Case-Shiller US National Home Price Index', unit: 'index', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 115,
    notes: 'Published with a two-month lag, so treat it as confirmation rather than warning.' },
  { fred: 'MSACSR', id: 'us.months_supply_homes', name: 'Monthly Supply of New Houses', unit: 'months', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'RECPROUSM156N', id: 'us.recession_probability', name: 'Smoothed US Recession Probability', unit: 'percent', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 90 },
  { fred: 'PPIACO', id: 'us.ppi', name: 'Producer Price Index: All Commodities', unit: 'index', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80 },
  { fred: 'TDSP', id: 'us.debt_service_ratio', name: 'Household Debt Service Ratio', unit: 'percent of disposable income', cadence: 'quarterly', pillar: 'realecon', stalenessBudgetDays: 230 },
  { fred: 'USREC', id: 'us.nber_recession', name: 'NBER Recession Indicator', unit: '0 or 1', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 400,
    notes: 'Declared retrospectively, so useless as a warning — but it is the ground truth the golden-fixture tests score the model against.' },

  // ------------------------------------------------------------------ energy
  { fred: 'DCOILWTICO', id: 'oil.wti', name: 'Crude Oil WTI Spot', unit: 'USD per barrel', cadence: 'daily', pillar: 'energy', stalenessBudgetDays: 7 },
  { fred: 'DCOILBRENTEU', id: 'oil.brent', name: 'Crude Oil Brent Spot', unit: 'USD per barrel', cadence: 'daily', pillar: 'energy', stalenessBudgetDays: 7 },
  { fred: 'DHHNGSP', id: 'gas.henry_hub', name: 'Henry Hub Natural Gas Spot', unit: 'USD per MMBtu', cadence: 'daily', pillar: 'energy', stalenessBudgetDays: 7 },

  // ---------------------------------------------------------------- markets
  { fred: 'VIXCLS', id: 'mkt.vix', name: 'CBOE Volatility Index', unit: 'index', cadence: 'daily', pillar: 'markets', stalenessBudgetDays: 5 },
  { fred: 'SP500', id: 'mkt.sp500', name: 'S&P 500', unit: 'index', cadence: 'daily', pillar: 'markets', stalenessBudgetDays: 5 },
  { fred: 'NASDAQCOM', id: 'mkt.nasdaq', name: 'NASDAQ Composite', unit: 'index', cadence: 'daily', pillar: 'markets', stalenessBudgetDays: 5 },
  { fred: 'DJIA', id: 'mkt.djia', name: 'Dow Jones Industrial Average', unit: 'index', cadence: 'daily', pillar: 'markets', stalenessBudgetDays: 5,
    notes: 'Used for the Dow/Gold ratio, one of the oldest sound-money valuation measures.' },
  { fred: 'VXVCLS', id: 'mkt.vix3m', name: 'CBOE 3-Month Volatility Index', unit: 'index', cadence: 'daily', pillar: 'markets', stalenessBudgetDays: 6,
    notes: 'Paired with VIX to detect term-structure inversion — near-term fear exceeding long-term fear, which flags acute stress earlier than the VIX level alone.' },
  { fred: 'GVZCLS', id: 'mkt.gold_vol', name: 'CBOE Gold ETF Volatility Index', unit: 'index', cadence: 'daily', pillar: 'monetary', stalenessBudgetDays: 6,
    notes: 'Rising gold volatility alongside a rising gold price indicates monetary panic rather than an orderly repricing.' },
  { fred: 'OVXCLS', id: 'mkt.oil_vol', name: 'CBOE Crude Oil ETF Volatility Index', unit: 'index', cadence: 'daily', pillar: 'energy', stalenessBudgetDays: 6 },
  { fred: 'NIKKEI225', id: 'mkt.nikkei', name: 'Nikkei 225', unit: 'index', cadence: 'daily', pillar: 'markets', stalenessBudgetDays: 6,
    notes: 'Japan carries the largest carry-trade and duration exposure in the system; a disorderly Nikkei is a global funding signal.' },

  // ------------------------------------------------- industrial & chip metals
  // The IMF primary-commodity panel, republished by FRED. Monthly, because the
  // daily benchmark for every one of these is LME or Fastmarkets pricing, which
  // is licensed and not free. Monthly is the honest ceiling for this data, and
  // the UI labels the cadence rather than implying a live tape.
  //
  // Read as a block these are the physical input costs of the silicon supply
  // chain: copper for interconnect and power delivery, tin for solder, gold and
  // silver for bonding wire and conductive paste, palladium and nickel for MLCC
  // terminations, aluminium for heat spreaders and interconnect, uranium and gas
  // for the electricity a fab burns. Cobalt, lithium, polysilicon and the rare
  // earths have no free reference price at all — the listed miner indices below
  // are the closest freely available proxy, and are named as proxies.
  { fred: 'PCOPPUSDM', id: 'cmd.copper', name: 'Copper', unit: 'USD per metric ton', cadence: 'monthly', pillar: 'trade', stalenessBudgetDays: 80,
    notes: '"Dr. Copper" — the metal every grid, motor and chip interconnect needs. Against gold it is a clean growth-versus-fear ratio: both are metals, only one is monetary. Monthly here; daily LME pricing is not freely licensed.' },
  { fred: 'PALUMUSDM', id: 'cmd.aluminum', name: 'Aluminium', unit: 'USD per metric ton', cadence: 'monthly', pillar: 'trade', stalenessBudgetDays: 80,
    notes: 'Roughly 40% of its cost is electricity, so aluminium prices carry the energy shock into manufacturing faster than most metals. Used in chip packaging, heat spreaders and on-die interconnect.' },
  { fred: 'PNICKUSDM', id: 'cmd.nickel', name: 'Nickel', unit: 'USD per metric ton', cadence: 'monthly', pillar: 'trade', stalenessBudgetDays: 80,
    notes: 'Stainless steel, batteries, and the barrier layers and MLCC electrodes inside electronics. The 2022 LME nickel squeeze is the reference example of a metal market breaking outright.' },
  { fred: 'PTINUSDM', id: 'cmd.tin', name: 'Tin', unit: 'USD per metric ton', cadence: 'monthly', pillar: 'trade', stalenessBudgetDays: 80,
    notes: 'The solder metal: almost every electrical joint in every device. Supply is unusually concentrated (Indonesia, Myanmar, China), which makes tin the most geopolitically fragile of the chip inputs.' },
  { fred: 'PZINCUSDM', id: 'cmd.zinc', name: 'Zinc', unit: 'USD per metric ton', cadence: 'monthly', pillar: 'trade', stalenessBudgetDays: 80,
    notes: 'Galvanising and die-casting — construction and vehicles. Included as breadth: a metals move confined to one metal is a supply story, a move across all of them is a monetary or demand story.' },
  { fred: 'PLEADUSDM', id: 'cmd.lead', name: 'Lead', unit: 'USD per metric ton', cadence: 'monthly', pillar: 'trade', stalenessBudgetDays: 80,
    notes: 'Mostly batteries. Kept for breadth across the base-metal complex.' },
  { fred: 'PIORECRUSDM', id: 'cmd.iron_ore', name: 'Iron Ore', unit: 'USD per metric ton', cadence: 'monthly', pillar: 'trade', stalenessBudgetDays: 80,
    notes: 'The purest read on Chinese construction demand available for free, and the first industrial commodity to break when Chinese property stalls.' },
  { fred: 'PURANUSDM', id: 'cmd.uranium', name: 'Uranium', unit: 'USD per pound', cadence: 'monthly', pillar: 'energy', stalenessBudgetDays: 80,
    notes: 'Fuel for the baseload that fabs and data centres run on. A structurally supply-constrained market that repriced hard as AI power demand arrived.' },

  // ------------------------------------------------------ semiconductor complex
  { fred: 'NASDAQSOX', id: 'semi.sox', name: 'PHLX Semiconductor Index (SOX)', unit: 'index', cadence: 'daily', pillar: 'markets', stalenessBudgetDays: 5,
    notes: 'The daily market-priced read on the chip cycle, and the only high-frequency member of this group. Semis lead the broad industrial cycle by roughly two quarters in both directions.' },
  { fred: 'IPG3344S', id: 'semi.production', name: 'Semiconductor & Electronic Component Production', unit: 'index (2017=100)', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80,
    notes: 'Physical output of US semiconductor and component plants — volume, not price, so it is unaffected by the pricing games that distort revenue figures.' },
  { fred: 'PCU334413334413', id: 'semi.ppi', name: 'Semiconductor Device Producer Prices', unit: 'index (Dec 1998=100)', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 80,
    notes: 'Chip prices at the factory gate. Decades of steady deflation is the normal state; sustained increases mean scarcity pricing, and a sharp fall means the glut phase of the cycle has begun.' },
  { fred: 'A34SNO', id: 'semi.new_orders', name: 'New Orders — Computers & Electronics', unit: 'millions USD', cadence: 'monthly', pillar: 'realecon', stalenessBudgetDays: 100,
    notes: 'Order intake leads shipments, so this turns before production does. The cleanest free forward-looking series on electronics demand.' },
  { fred: 'NASDAQNSLITP', id: 'semi.lithium_miners', name: 'Lithium Miners Index (battery-metal proxy)', unit: 'index', cadence: 'daily', pillar: 'markets', stalenessBudgetDays: 6,
    notes: 'A proxy, not a price: lithium and cobalt have no free spot reference, so the listed miners stand in for the battery-metal complex. Equity beta contaminates it — read direction, never level.' },

  // --------------------------------------------------------------------- fx
  { fred: 'DTWEXBGS', id: 'fx.broad_dollar', name: 'Nominal Broad US Dollar Index', unit: 'index', cadence: 'daily', pillar: 'fx', stalenessBudgetDays: 10,
    notes: 'A rising dollar tightens global financial conditions regardless of what the Fed says.' },
  { fred: 'DEXCHUS', id: 'fx.cny_onshore', name: 'China / US Foreign Exchange Rate (onshore CNY)', unit: 'CNY per USD', cadence: 'daily', pillar: 'fx', stalenessBudgetDays: 10 },
  // The mirror image of the FIMA facility: dollars foreign central banks are
  // parking *at* the Fed rather than borrowing from it. Unlike FIMA this has a
  // full history back to 2002 and is never zero, so it is chartable and
  // percentile-able — but it is deliberately left unscored in indicators.yaml
  // because its direction is genuinely ambiguous. A drawdown can mean reserves
  // are being spent defending a currency (bearish) or simply redeployed into
  // bills (neutral), and the series alone cannot tell those apart.
  { fred: 'WLRRAFOIAL', id: 'fx.foreign_repo_pool', name: 'Foreign Official Reverse Repo Pool', unit: 'millions USD', cadence: 'weekly', pillar: 'fx', stalenessBudgetDays: 12,
    notes: 'Overnight dollars held at the Fed by foreign central banks and international accounts. Sharp drawdowns have coincided with FX intervention episodes, when reserves are converted to spend.' },

  // ------------------------------------------------------------------ trade
  { fred: 'BOPGSTB', id: 'us.trade_balance', name: 'US Trade Balance: Goods and Services', unit: 'millions USD', cadence: 'monthly', pillar: 'trade', stalenessBudgetDays: 70 },
  { fred: 'IMPGS', id: 'us.imports', name: 'US Imports of Goods and Services', unit: 'billions USD SAAR', cadence: 'quarterly', pillar: 'trade', stalenessBudgetDays: 260 },
];

interface FredResponse {
  observations?: Array<{ date: string; value: string }>;
  error_message?: string;
}

/**
 * Federal Reserve Economic Data (St. Louis Fed).
 *
 * Each series is fetched independently and a failure is recorded as a warning
 * rather than an error. With a catalogue this size, one retired or renamed
 * series ID must not take down the other sixty — and `doctor` surfaces exactly
 * which ones need attention.
 */
export const fredConnector: Connector = {
  id: 'fred',
  name: 'FRED (Federal Reserve Economic Data)',
  homepage: 'https://fred.stlouisfed.org/docs/api/fred/',
  cadence: 'daily',
  requiresKey: 'FRED_API_KEY',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    const key = ctx.env.FRED_API_KEY;
    if (!key) throw new Error('FRED_API_KEY is not set');

    const observations: Observation[] = [];
    const warnings: string[] = [];
    const ok: FredSeries[] = [];

    // FRED permits 120 requests/minute. Six at a time with this catalogue keeps
    // us well inside that even when every request is a cache miss.
    const queue = [...CATALOG];
    const worker = async (): Promise<void> => {
      for (;;) {
        const s = queue.shift();
        if (!s) return;
        const url = 'https://api.stlouisfed.org/fred/series/observations'
          + `?series_id=${encodeURIComponent(s.fred)}`
          + `&api_key=${encodeURIComponent(key)}`
          + '&file_type=json'
          + `&observation_start=${ctx.since}`;
        try {
          const res = await ctx.http.getJson<FredResponse>(url, { cacheTtlHours: 8 });
          if (!res || res.error_message) {
            warnings.push(`${s.fred}: ${res?.error_message ?? 'empty response'}`);
            continue;
          }
          const rows = res.observations ?? [];
          let n = 0;
          for (const o of rows) {
            // FRED encodes missing data as "."; num() maps that to null.
            const v = num(o.value);
            if (v === null) continue;
            observations.push({ seriesId: s.id, obsDate: o.date, value: v });
            n++;
          }
          if (n === 0) warnings.push(`${s.fred}: no observations since ${ctx.since}`);
          else ok.push(s);
        } catch (err) {
          warnings.push(`${s.fred}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));

    ctx.log(`${ok.length}/${CATALOG.length} series returned data`);
    if (ok.length === 0) {
      throw new Error(`No FRED series returned data. First errors: ${warnings.slice(0, 3).join('; ')}`);
    }

    const series: SeriesDef[] = ok.map((s) => ({
      id: s.id,
      name: s.name,
      unit: s.unit,
      cadence: s.cadence,
      sourceId: 'fred',
      pillar: s.pillar,
      sourceUrl: `https://fred.stlouisfed.org/series/${s.fred}`,
      notes: s.notes,
      stalenessBudgetDays: s.stalenessBudgetDays,
    }));

    return { series, observations, warnings: warnings.length ? warnings : undefined };
  },
};

export const FRED_CATALOG = CATALOG;
