import type { Connector, ConnectorResult, FetchCtx, Observation, SeriesDef, WorldEvent } from '@wd/core';
import { createHash } from 'node:crypto';

interface Topic {
  id: string;
  name: string;
  /**
   * GDELT query. Parentheses may ONLY wrap OR'd groups — wrapping a single
   * term returns a plain-text error rather than JSON.
   * Every query is additionally constrained to English sources at request time;
   * without that, these broad phrases match loosely across ~65 languages and the
   * feed fills with unrelated domestic politics.
   */
  query: string;
  /** Baseline severity for events matching this topic, 0-100. */
  severity: number;
  notes: string;
}

/**
 * Standing queries.
 *
 * These target exactly the events that hard statistics report far too late:
 * a central bank selling gold shows up in IMF data months afterwards, and a
 * country dumping Treasuries appears in TIC with a six-week lag. News breaks it
 * the same day.
 */
const TOPICS: Topic[] = [
  {
    id: 'cb_gold',
    name: 'Central bank gold buying and selling',
    query: '("central bank gold" OR "gold reserves") (purchase OR bought OR buying OR sold OR selling OR added)',
    severity: 45,
    notes: 'Official-sector gold flows. Sustained buying is de-dollarisation; selling by a stressed sovereign is a liquidity signal.',
  },
  {
    id: 'treasury_selling',
    name: 'Sovereign Treasury selling',
    query: '("US Treasuries" OR "Treasury holdings" OR "Treasury securities") (sold OR selling OR dumped OR reduced OR offloading)',
    severity: 60,
    notes: 'Foreign official selling of US government debt, weeks before it appears in TIC data.',
  },
  {
    id: 'sovereign_default',
    name: 'Sovereign default and restructuring',
    query: '("sovereign default" OR "debt restructuring" OR "debt moratorium" OR "default on its debt")',
    severity: 80,
    notes: 'Sovereign defaults cluster. The first is rarely the last.',
  },
  {
    id: 'bank_failure',
    name: 'Bank runs and failures',
    query: '("bank run" OR "bank failure" OR "bank collapse" OR "deposit flight" OR "bank bailout")',
    severity: 75,
    notes: 'Bank failures propagate through confidence faster than through balance sheets.',
  },
  {
    id: 'capital_controls',
    name: 'Capital controls and currency restrictions',
    query: '("capital controls" OR "currency controls" OR "withdrawal limits" OR "exchange restrictions")',
    severity: 70,
    notes: 'Capital controls are the admission that a currency cannot be defended at the current price.',
  },
  {
    id: 'devaluation',
    name: 'Currency devaluation',
    query: '(devaluation OR devalued) (currency OR peg OR exchange)',
    severity: 65,
    notes: 'Devaluations are contagious among economies competing in the same export markets.',
  },
  {
    id: 'auction_failure',
    name: 'Failed or weak bond auctions',
    query: '("bond auction" OR "debt auction" OR "gilt auction") (failed OR weak OR poor OR undersubscribed OR tailed)',
    severity: 70,
    notes: 'The event the auction-takedown series is designed to anticipate quantitatively.',
  },
  {
    id: 'emergency_policy',
    name: 'Emergency central bank action',
    query: '("central bank" OR "Federal Reserve" OR ECB) ("emergency meeting" OR "emergency rate" OR unscheduled OR "emergency lending")',
    severity: 75,
    notes: 'Unscheduled central bank action means something broke that was not supposed to break.',
  },
];

interface ArtListResponse {
  articles?: Array<{ url?: string; title?: string; seendate?: string; domain?: string; sourcecountry?: string }>;
}

interface TimelineResponse {
  timeline?: Array<{ data?: Array<{ date?: string; value?: number }> }>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * GDELT DOC 2.0 — global news monitoring.
 *
 * Free and unauthenticated, which is remarkable for what it provides. Used in
 * two distinct ways:
 *
 *  - **ArtList** gives the article feed — the human-readable "what happened".
 *  - **TimelineVol** gives daily coverage volume as a *number*, which means
 *    narrative intensity becomes a scoreable series sitting alongside hard data
 *    rather than a separate qualitative annex.
 *
 * The second is the interesting one. It cannot tell you whether a story is
 * true, only how loudly the world is discussing it — so it is weighted lightly
 * and treated as corroboration, never as primary evidence.
 *
 * GDELT asks for no more than one request every five seconds, which this
 * connector respects; a full pass therefore takes roughly 90 seconds.
 */
export const gdeltConnector: Connector = {
  id: 'gdelt',
  name: 'GDELT — Global News Event Monitoring',
  homepage: 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/',
  cadence: 'daily',
  optional: true,
  caveat: 'Rate limited to one request per 5s, so a full pass takes ~90s. Measures coverage volume, not truth.',

  async run(ctx: FetchCtx): Promise<ConnectorResult> {
    const events: WorldEvent[] = [];
    const observations: Observation[] = [];
    const series: SeriesDef[] = [];
    const warnings: string[] = [];

    for (const topic of TOPICS) {
      // --- article feed ---
      try {
        const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
          + `?query=${encodeURIComponent(`${topic.query} sourcelang:english`)}`
          + '&mode=ArtList&maxrecords=40&format=json&timespan=7d&sort=datedesc';
        // Few retries: GDELT's limiter counts every attempt, so aggressive
        // retrying makes the rate-limit problem worse rather than better.
        const res = await ctx.http.getJson<ArtListResponse>(url, { cacheTtlHours: 6, retries: 1 });
        for (const a of res?.articles ?? []) {
          if (!a.url || !a.title) continue;
          events.push({
            // Hash the URL so re-running never duplicates an article.
            id: createHash('sha256').update(`${topic.id}|${a.url}`).digest('hex').slice(0, 32),
            ts: parseSeenDate(a.seendate) ?? new Date().toISOString(),
            sourceId: 'gdelt',
            category: topic.id,
            headline: a.title.slice(0, 500),
            url: a.url,
            severity: topic.severity,
            entities: [a.sourcecountry, a.domain].filter((x): x is string => Boolean(x)),
          });
        }
      } catch (err) {
        warnings.push(`${topic.id} articles: ${(err as Error).message}`);
      }
      await sleep(6500);

      // --- coverage volume as a numeric series ---
      try {
        const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
          + `?query=${encodeURIComponent(`${topic.query} sourcelang:english`)}`
          + '&mode=TimelineVol&format=json&timespan=12m';
        const res = await ctx.http.getJson<TimelineResponse>(url, { cacheTtlHours: 12, retries: 1 });
        const points = res?.timeline?.[0]?.data ?? [];
        let n = 0;
        for (const p of points) {
          const date = parseSeenDate(p.date)?.slice(0, 10);
          if (!date || typeof p.value !== 'number' || !Number.isFinite(p.value)) continue;
          observations.push({ seriesId: `news.${topic.id}`, obsDate: date, value: p.value });
          n++;
        }
        if (n > 0) {
          series.push({
            id: `news.${topic.id}`,
            name: `News intensity — ${topic.name}`,
            unit: 'percent of global coverage',
            cadence: 'daily',
            sourceId: 'gdelt',
            pillar: 'narrative',
            sourceUrl: 'https://www.gdeltproject.org/',
            notes: `${topic.notes} Measures how much the world is talking about this, not whether it is true — corroboration only.`,
            stalenessBudgetDays: 5,
          });
        }
      } catch (err) {
        warnings.push(`${topic.id} timeline: ${(err as Error).message}`);
      }
      await sleep(6500);
    }

    ctx.log(`${events.length} events, ${series.length} narrative series`);
    if (events.length === 0 && series.length === 0) {
      throw new Error(`GDELT returned nothing. ${warnings.slice(0, 2).join('; ')}`);
    }
    return { series, observations, events, warnings: warnings.length ? warnings : undefined };
  },
};

/** GDELT stamps are `YYYYMMDDTHHMMSSZ` or `YYYYMMDDHHMMSS`. */
function parseSeenDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', sec = '00'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}
