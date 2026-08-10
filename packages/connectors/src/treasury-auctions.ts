import type { Connector, ConnectorResult, FetchCtx, Observation, SeriesDef } from '@wd/core';
import { isoDate, num } from './util.js';

const BASE = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query';

const FIELDS = [
  'auction_date', 'security_type', 'security_term', 'original_security_term',
  'bid_to_cover_ratio', 'total_accepted', 'primary_dealer_accepted',
  'indirect_bidder_accepted', 'direct_bidder_accepted', 'high_yield', 'offering_amt',
].join(',');

/** Coupon tenors we score. Bills are tracked in aggregate; they are noisier and less informative. */
const COUPON_TERMS: Record<string, string> = {
  '2-Year': '2y',
  '3-Year': '3y',
  '5-Year': '5y',
  '7-Year': '7y',
  '10-Year': '10y',
  '20-Year': '20y',
  '30-Year': '30y',
};

interface AuctionRow {
  auction_date: string;
  security_type: string;
  security_term: string;
  original_security_term: string;
  bid_to_cover_ratio: string;
  total_accepted: string;
  primary_dealer_accepted: string;
  indirect_bidder_accepted: string;
  direct_bidder_accepted: string;
}

/**
 * US Treasury auction results.
 *
 * The highest-signal source in this dashboard and one almost nobody charts.
 * A government funding itself is the load-bearing assumption under the entire
 * financial system, and auctions are where that assumption gets tested in
 * public twice a week.
 *
 * Three metrics, in increasing order of usefulness:
 *
 *  - **Bid-to-cover** — total bids over amount sold. The headline number.
 *  - **Indirect share** — largely foreign central banks and funds. Falling
 *    indirect participation is foreign demand withdrawing.
 *  - **Primary dealer share** — the one that matters most. Dealers are
 *    obligated to bid, so they absorb whatever real buyers leave behind. A
 *    *rising* dealer takedown means end-user demand is failing, and it shows up
 *    before yields visibly break. This is the "failed auction" signal in its
 *    early, quantitative form.
 */
export const treasuryAuctionsConnector: Connector = {
  id: 'treasury-auctions',
  name: 'US Treasury Auction Results',
  homepage: 'https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/',
  cadence: 'irregular',
  // Coupon auctions cluster mid-month; a fortnight-long gap is normal.
  caveat: 'Auctions are irregular — several per week for bills, roughly monthly per coupon tenor.',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    const rows = await fetchAllPages(ctx);
    ctx.log(`fetched ${rows.length} auction records since ${ctx.since}`);

    const observations: Observation[] = [];
    const seen = new Set<string>();
    // Coupon auctions on the same date are combined dollar-weighted, so a
    // 3-year and a 10-year on one day don't produce two competing points.
    const couponByDate = new Map<string, { dealer: number; indirect: number; total: number; btcWeighted: number }>();

    for (const r of rows) {
      const date = isoDate(r.auction_date);
      const btc = num(r.bid_to_cover_ratio);
      const total = num(r.total_accepted);
      if (!date || btc === null || total === null || total <= 0) continue; // announced-but-not-yet-held

      const dealer = num(r.primary_dealer_accepted);
      const indirect = num(r.indirect_bidder_accepted);
      const termKey = COUPON_TERMS[r.original_security_term];

      if (termKey) {
        observations.push({ seriesId: `ust.auction.btc.${termKey}`, obsDate: date, value: btc });
        seen.add(`ust.auction.btc.${termKey}`);

        if (dealer !== null) {
          const share = (dealer / total) * 100;
          observations.push({ seriesId: `ust.auction.dealer.${termKey}`, obsDate: date, value: share });
          seen.add(`ust.auction.dealer.${termKey}`);
        }
        if (indirect !== null) {
          const share = (indirect / total) * 100;
          observations.push({ seriesId: `ust.auction.indirect.${termKey}`, obsDate: date, value: share });
          seen.add(`ust.auction.indirect.${termKey}`);
        }

        const agg = couponByDate.get(date) ?? { dealer: 0, indirect: 0, total: 0, btcWeighted: 0 };
        agg.dealer += dealer ?? 0;
        agg.indirect += indirect ?? 0;
        agg.total += total;
        agg.btcWeighted += btc * total;
        couponByDate.set(date, agg);
      }
    }

    for (const [date, agg] of couponByDate) {
      if (agg.total <= 0) continue;
      observations.push({ seriesId: 'ust.auction.btc.coupon', obsDate: date, value: agg.btcWeighted / agg.total });
      observations.push({ seriesId: 'ust.auction.dealer.coupon', obsDate: date, value: (agg.dealer / agg.total) * 100 });
      observations.push({ seriesId: 'ust.auction.indirect.coupon', obsDate: date, value: (agg.indirect / agg.total) * 100 });
      seen.add('ust.auction.btc.coupon');
      seen.add('ust.auction.dealer.coupon');
      seen.add('ust.auction.indirect.coupon');
    }

    if (observations.length === 0) {
      throw new Error(`No completed auctions found since ${ctx.since}`);
    }
    return { series: buildSeriesDefs(seen), observations };
  },
};

async function fetchAllPages(ctx: FetchCtx): Promise<AuctionRow[]> {
  const out: AuctionRow[] = [];
  const pageSize = 5000;
  for (let page = 1; page <= 40; page++) {
    const url = `${BASE}?fields=${FIELDS}`
      + `&filter=auction_date:gte:${ctx.since}`
      + `&sort=auction_date`
      + `&page%5Bsize%5D=${pageSize}&page%5Bnumber%5D=${page}`;
    const json = await ctx.http.getJson<{ data: AuctionRow[]; meta?: { 'total-pages'?: number } }>(
      url, { cacheTtlHours: 12 },
    );
    const data = json?.data ?? [];
    out.push(...data);
    const totalPages = json?.meta?.['total-pages'] ?? 1;
    if (data.length < pageSize || page >= totalPages) break;
  }
  return out;
}

function buildSeriesDefs(seen: Set<string>): SeriesDef[] {
  const base = {
    sourceId: 'treasury-auctions',
    cadence: 'irregular' as const,
    // Any coupon tenor should reappear within ~6 weeks; longer means either a
    // schedule change or a broken feed, and both are worth surfacing.
    stalenessBudgetDays: 45,
    pillar: 'sovereign' as const,
    sourceUrl: 'https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/',
  };
  const defs: SeriesDef[] = [];

  const metrics: Array<{ prefix: string; label: string; unit: string; notes: string }> = [
    {
      prefix: 'btc',
      label: 'Bid-to-Cover',
      unit: 'ratio',
      notes: 'Total bids divided by amount sold. Lower means weaker demand.',
    },
    {
      prefix: 'dealer',
      label: 'Primary Dealer Takedown',
      unit: 'percent of accepted',
      notes: 'Dealers must bid, so they absorb what real buyers decline. Rising share = end-user demand failing.',
    },
    {
      prefix: 'indirect',
      label: 'Indirect Bidder Share',
      unit: 'percent of accepted',
      notes: 'Largely foreign central banks and funds. Falling share = foreign demand withdrawing.',
    },
  ];

  for (const m of metrics) {
    for (const [term, key] of Object.entries(COUPON_TERMS)) {
      const id = `ust.auction.${m.prefix}.${key}`;
      if (seen.has(id)) {
        defs.push({ ...base, id, name: `${term} Auction ${m.label}`, unit: m.unit, notes: m.notes });
      }
    }
    const aggId = `ust.auction.${m.prefix}.coupon`;
    if (seen.has(aggId)) {
      defs.push({
        ...base,
        id: aggId,
        name: `All-Coupon Auction ${m.label}`,
        unit: m.unit,
        notes: `${m.notes} Dollar-weighted across all coupon auctions on the date.`,
      });
    }
  }
  return defs;
}
