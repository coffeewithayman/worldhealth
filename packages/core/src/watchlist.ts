import { latestValue, minOver, valueAsOf, type SeriesData } from './scoring.js';
import { percentileRank } from './stats.js';
import type { IsoDate } from './types.js';

export interface WatchlistResult {
  id: string;
  name: string;
  /** What this signal means and why it is depression-distinct rather than merely recessionary. */
  rationale: string;
  triggered: boolean;
  /** 0-100 severity, so a signal can be "approaching" rather than merely on/off. */
  severity: number;
  detail: string;
  /** Null when the required inputs are unavailable — reported as unknown, never as "safe". */
  available: boolean;
}

export interface WatchlistItem {
  id: string;
  name: string;
  rationale: string;
  evaluate(data: SeriesData, asOfDate: IsoDate): Omit<WatchlistResult, 'id' | 'name' | 'rationale'>;
}

const unavailable = (detail: string): Omit<WatchlistResult, 'id' | 'name' | 'rationale'> => ({
  triggered: false, severity: 0, detail, available: false,
});

function shiftDays(iso: IsoDate, n: number): IsoDate {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The Depression Precursor Watchlist.
 *
 * Kept separate from the weighted composite on purpose. Averaging destroys
 * exactly the information these carry: each one is individually rare and
 * individually meaningful, and a single lit item can matter more than a
 * ten-point move in the composite. They are never averaged away.
 *
 * Every rule reports `available: false` rather than `triggered: false` when its
 * inputs are missing. A signal that cannot be evaluated must never be displayed
 * as a signal that is quiet.
 */
export const WATCHLIST: WatchlistItem[] = [
  {
    id: 'curve_resteepening',
    name: 'Deep inversion now re-steepening',
    rationale:
      'Yield curves invert for a year or more without incident. The downturn historically begins as a deep inversion '
      + 'rapidly re-steepens, because the market has started pricing emergency rate cuts. Watching the level alone gets this backwards.',
    evaluate: (data, date) => {
      const curr = latestValue(data, 'ust.spread.10y2y', date);
      const change = latestValue(data, 'd.curve_steepening_90d', date);
      if (!curr || !change) return unavailable('needs ust.spread.10y2y and d.curve_steepening_90d');
      const trough = minOver(data, 'ust.spread.10y2y', date, 730);
      if (trough === null) return unavailable('insufficient curve history');

      const wasDeeplyInverted = trough <= -25;
      const steepeningFast = change.value >= 40;
      const triggered = wasDeeplyInverted && steepeningFast && curr.value > trough + 40;
      // Severity blends how deep the prior inversion was with how fast it is unwinding.
      const depthPart = Math.min(100, Math.max(0, (-trough / 100) * 100));
      const speedPart = Math.min(100, Math.max(0, (change.value / 100) * 100));
      const severity = wasDeeplyInverted ? Math.min(100, depthPart * 0.4 + speedPart * 0.6) : Math.max(0, speedPart * 0.3);
      return {
        triggered,
        severity,
        available: true,
        detail: `10y-2y at ${curr.value.toFixed(0)}bp; 2y trough ${trough.toFixed(0)}bp; 90-day change ${change.value >= 0 ? '+' : ''}${change.value.toFixed(0)}bp`,
      };
    },
  },

  {
    id: 'hy_spread_blowout',
    name: 'High-yield spreads blowing out',
    rationale:
      'Credit leads equities into every serious downturn. Sustained high-yield spreads above 800bp mark the point where '
      + 'refinancing stops being available to weaker borrowers, which converts a slowdown into a default cycle.',
    evaluate: (data, date) => {
      const curr = latestValue(data, 'us.hy_oas', date);
      if (!curr) return unavailable('needs us.hy_oas');
      const prior = valueAsOf(data, 'us.hy_oas', shiftDays(date, -30));
      const widening = prior !== null && curr.value > prior;
      const bp = curr.value * 100;
      const triggered = bp >= 800 && widening;
      const severity = Math.min(100, Math.max(0, ((bp - 300) / 700) * 100));
      return {
        triggered,
        severity,
        available: true,
        detail: `HY OAS ${bp.toFixed(0)}bp${prior !== null ? `, ${widening ? 'widening' : 'tightening'} over 30 days` : ''}`,
      };
    },
  },

  {
    id: 'm2_contraction',
    name: 'M2 money supply contracting',
    rationale:
      'Outright year-over-year contraction in M2 has occurred in the 1930s and in 2023, and essentially nowhere else in the modern record. '
      + 'In a credit-based system, a shrinking money stock is not a slowdown signal — it is the mechanism of a depression.',
    evaluate: (data, date) => {
      const yoy = latestValue(data, 'd.m2_yoy', date);
      if (!yoy) return unavailable('needs d.m2_yoy');
      const triggered = yoy.value < 0;
      // Anything below +2% is unusual; below 0 is the historical alarm.
      const severity = Math.min(100, Math.max(0, ((2 - yoy.value) / 6) * 100));
      return {
        triggered,
        severity,
        available: true,
        detail: `M2 ${yoy.value >= 0 ? '+' : ''}${yoy.value.toFixed(2)}% year-over-year as of ${yoy.date}`,
      };
    },
  },

  {
    id: 'bank_credit_contraction',
    name: 'Bank credit contracting',
    rationale:
      'Bank lending creates most of the money in circulation. When aggregate bank credit shrinks, money is destroyed faster '
      + 'than any central bank facility replaces it. This is the transmission channel from financial stress to real depression.',
    evaluate: (data, date) => {
      const yoy = latestValue(data, 'd.bank_credit_yoy', date);
      if (!yoy) return unavailable('needs d.bank_credit_yoy');
      const triggered = yoy.value < 0;
      const severity = Math.min(100, Math.max(0, ((3 - yoy.value) / 8) * 100));
      return {
        triggered,
        severity,
        available: true,
        detail: `Bank credit ${yoy.value >= 0 ? '+' : ''}${yoy.value.toFixed(2)}% year-over-year as of ${yoy.date}`,
      };
    },
  },

  {
    id: 'sahm_rule',
    name: 'Sahm rule triggered',
    rationale:
      'Unemployment rising 0.50pp above its recent low has identified every US recession since 1970 with no false positives. '
      + 'It confirms rather than predicts, but it converts an ambiguous picture into an unambiguous one.',
    evaluate: (data, date) => {
      const s = latestValue(data, 'us.sahm_rule', date);
      if (!s) return unavailable('needs us.sahm_rule');
      const triggered = s.value >= 0.5;
      const severity = Math.min(100, Math.max(0, (s.value / 1.0) * 100));
      return {
        triggered,
        severity,
        available: true,
        detail: `Sahm indicator ${s.value.toFixed(2)}pp (triggers at 0.50) as of ${s.date}`,
      };
    },
  },

  {
    id: 'swap_lines_drawn',
    name: 'Central bank dollar swap lines drawn',
    rationale:
      'These sit at essentially zero in normal times and went from nothing to hundreds of billions within days in both 2008 and 2020. '
      + 'Any material drawing means foreign banks cannot obtain dollars in the market — the cleanest global dollar-shortage alarm that exists.',
    evaluate: (data, date) => {
      const s = latestValue(data, 'us.cb_liquidity_swaps', date);
      if (!s) return unavailable('needs us.cb_liquidity_swaps');
      const millions = s.value;
      const triggered = millions >= 1000; // $1bn
      // 0 to $100bn spans the range from calm to full crisis.
      const severity = Math.min(100, Math.max(0, (millions / 100_000) * 100));
      return {
        triggered,
        severity,
        available: true,
        detail: `$${(millions / 1000).toFixed(2)}bn outstanding as of ${s.date}`,
      };
    },
  },

  {
    id: 'auction_demand_failure',
    name: 'Treasury auction demand deteriorating',
    rationale:
      'Primary dealers must bid, so they absorb whatever real buyers decline. A sustained rise in dealer takedown means genuine '
      + 'demand for government debt is failing — the early, quantitative form of a failed auction, visible well before yields break.',
    evaluate: (data, date) => {
      const avg = latestValue(data, 'd.auction_dealer_avg', date);
      if (!avg) return unavailable('needs d.auction_dealer_avg');
      const hist = (data.get('d.auction_dealer_avg') ?? []).filter((o) => o.obsDate <= date).map((o) => o.value);
      if (hist.length < 30) return unavailable(`only ${hist.length} smoothed auction points (need 30)`);
      const pct = percentileRank(hist, avg.value) * 100;
      const triggered = pct >= 90;
      return {
        triggered,
        severity: pct,
        available: true,
        detail: `Dealer takedown averaging ${avg.value.toFixed(1)}% — ${pct.toFixed(0)}th percentile of its own history`,
      };
    },
  },

  {
    id: 'sovereign_spread_blowout',
    name: 'Sovereign credit stress',
    rationale:
      'Emerging-market spreads widen first when global dollar liquidity tightens. Defaults in the periphery '
      + 'historically precede the core repricing its own risk. Measured with the EM high-yield *corporate* OAS: FRED '
      + 'carries no free sovereign OAS, and EM corporates are dollar-funded, so they squeeze on the same channel.',
    evaluate: (data, date) => {
      const s = latestValue(data, 'em.sovereign_oas', date);
      if (!s) return unavailable('needs em.sovereign_oas');
      const hist = (data.get('em.sovereign_oas') ?? []).filter((o) => o.obsDate <= date).map((o) => o.value);
      if (hist.length < 100) return unavailable(`only ${hist.length} observations (need 100)`);
      const pct = percentileRank(hist, s.value) * 100;
      const triggered = pct >= 90;
      return {
        triggered,
        severity: pct,
        available: true,
        detail: `EM high-yield corporate OAS ${(s.value * 100).toFixed(0)}bp — ${pct.toFixed(0)}th percentile`,
      };
    },
  },

  {
    id: 'funding_stress',
    name: 'Repo and funding market stress',
    rationale:
      'Secured overnight rates trading persistently above the rate the Fed pays on reserves means the system is short of cash '
      + 'against collateral. This spread moved days before the September 2019 repo seizure.',
    evaluate: (data, date) => {
      const s = latestValue(data, 'd.sofr_iorb', date);
      if (!s) return unavailable('needs d.sofr_iorb');
      const triggered = s.value >= 10; // 10bp above IORB is a meaningful dislocation
      const severity = Math.min(100, Math.max(0, ((s.value + 10) / 40) * 100));
      return {
        triggered,
        severity,
        available: true,
        detail: `SOFR ${s.value >= 0 ? '+' : ''}${s.value.toFixed(1)}bp versus IORB as of ${s.date}`,
      };
    },
  },

  {
    id: 'gold_breadth',
    name: 'Gold rising against nearly all currencies',
    rationale:
      'The most sound-money-native signal here. Gold rising against one currency is that country’s problem. Gold at one-year highs '
      + 'against almost every currency simultaneously means the fiat system as a whole is being repriced — a monetary event, not a commodity rally.',
    evaluate: (data, date) => {
      const b = latestValue(data, 'd.gold_breadth', date);
      if (!b) return unavailable('needs d.gold_breadth (requires ECB FX and LBMA gold)');
      const triggered = b.value >= 80;
      return {
        triggered,
        severity: b.value,
        available: true,
        detail: `Gold at or near a 1-year high in ${b.value.toFixed(0)}% of tracked currencies as of ${b.date}`,
      };
    },
  },
];

export function evaluateWatchlist(data: SeriesData, asOfDate: IsoDate): WatchlistResult[] {
  return WATCHLIST.map((item) => ({
    id: item.id,
    name: item.name,
    rationale: item.rationale,
    ...item.evaluate(data, asOfDate),
  }));
}
