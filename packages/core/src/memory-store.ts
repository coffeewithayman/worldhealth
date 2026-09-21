import { daysBetween, todayIso } from './dates.js';
import type { EventFilter, SeriesFilter, Store } from './store.js';
import type {
  IsoDate, Observation, PipelineRun, PipelineStage, ScoreRecord,
  SeriesDef, SeriesHealth, SourceRun, WorldEvent,
} from './types.js';

/**
 * In-memory `Store`.
 *
 * Exists so the pipeline can be tested for the behaviour that matters most and
 * is hardest to observe in production: what happens when a connector throws,
 * when a stage dies halfway, when a series stops updating. Those paths are
 * unreachable in a test that needs a real database and a real network.
 *
 * It follows the same contracts as `SqliteStore` — upserts overwrite rather
 * than duplicate, non-finite values are rejected, observations come back in
 * date order — so a test passing here is evidence about the real store.
 */
export class MemoryStore implements Store {
  private series = new Map<string, SeriesDef>();
  private obs = new Map<string, Map<IsoDate, number>>();
  private runs: SourceRun[] = [];
  private pipeline: PipelineRun[] = [];
  private health = new Map<string, { lastSuccessAt: string }>();
  private scores = new Map<string, ScoreRecord>();
  private events = new Map<string, WorldEvent>();
  private backfilled = new Map<string, { at: string; since: IsoDate }>();
  closed = false;

  async migrate(): Promise<void> { /* nothing to create */ }

  async ping(): Promise<void> { if (this.closed) throw new Error('store closed'); }

  async upsertSeries(defs: SeriesDef[]): Promise<void> {
    for (const d of defs) this.series.set(d.id, { ...d });
  }

  async listSeries(filter: SeriesFilter = {}): Promise<SeriesDef[]> {
    return [...this.series.values()]
      .filter((s) => (!filter.pillar || s.pillar === filter.pillar)
        && (!filter.sourceId || s.sourceId === filter.sourceId))
      .sort((a, b) => byteCompare(a.id, b.id));
  }

  async getSeries(id: string): Promise<SeriesDef | null> {
    return this.series.get(id) ?? null;
  }

  async putObservations(obs: Observation[]): Promise<number> {
    let n = 0;
    for (const o of obs) {
      if (!Number.isFinite(o.value)) continue;
      let byDate = this.obs.get(o.seriesId);
      if (!byDate) { byDate = new Map(); this.obs.set(o.seriesId, byDate); }
      byDate.set(o.obsDate, o.value);
      n++;
    }
    return n;
  }

  async getObservations(seriesId: string, from?: IsoDate, to?: IsoDate): Promise<Observation[]> {
    const byDate = this.obs.get(seriesId);
    if (!byDate) return [];
    return [...byDate.entries()]
      .filter(([d]) => (!from || d >= from) && (!to || d <= to))
      .sort((a, b) => byteCompare(a[0], b[0]))
      .map(([obsDate, value]) => ({ seriesId, obsDate, value }));
  }

  async getLatestObservation(seriesId: string): Promise<Observation | null> {
    const all = await this.getObservations(seriesId);
    return all.at(-1) ?? null;
  }

  async getLatestObservations(seriesIds: string[]): Promise<Map<string, Observation>> {
    const out = new Map<string, Observation>();
    for (const id of seriesIds) {
      const latest = await this.getLatestObservation(id);
      if (latest) out.set(id, latest);
    }
    return out;
  }

  async recordRun(run: SourceRun): Promise<void> {
    this.runs.push({ ...run, id: this.runs.length + 1 });
  }

  async getLatestRuns(): Promise<SourceRun[]> {
    const latest = new Map<string, SourceRun>();
    for (const r of this.runs) {
      const seen = latest.get(r.sourceId);
      if (!seen || r.startedAt >= seen.startedAt) latest.set(r.sourceId, r);
    }
    return [...latest.values()].sort((a, b) => byteCompare(a.sourceId, b.sourceId));
  }

  async recordPipelineRun(run: PipelineRun): Promise<void> {
    this.pipeline.push({ ...run, id: this.pipeline.length + 1 });
  }

  async getLatestPipelineRuns(): Promise<PipelineRun[]> {
    const latest = new Map<string, PipelineRun>();
    for (const r of this.pipeline) {
      const seen = latest.get(r.stage);
      if (!seen || r.startedAt >= seen.startedAt) latest.set(r.stage, r);
    }
    return [...latest.values()].sort(newestFirst);
  }

  async getPipelineRuns(stage?: PipelineStage, limit = 50): Promise<PipelineRun[]> {
    return this.pipeline
      .filter((r) => !stage || r.stage === stage)
      .sort(newestFirst)
      .slice(0, limit);
  }

  async markSeriesSuccess(seriesIds: string[], at: string): Promise<void> {
    for (const id of seriesIds) this.health.set(id, { lastSuccessAt: at });
  }

  async getSeriesHealth(): Promise<SeriesHealth[]> {
    const today = todayIso();
    return [...this.series.values()]
      .sort((a, b) => byteCompare(a.id, b.id))
      .map((s) => {
        const dates = [...(this.obs.get(s.id)?.keys() ?? [])].sort();
        const lastObsDate = dates.at(-1) ?? null;
        const ageDays = lastObsDate ? daysBetween(lastObsDate, today) : null;
        const retired = s.retiredAt !== undefined;
        return {
          seriesId: s.id,
          lastObsDate,
          lastSuccessAt: this.health.get(s.id)?.lastSuccessAt ?? null,
          stalenessBudgetDays: s.stalenessBudgetDays,
          ageDays,
          stale: !retired && (ageDays === null || ageDays > s.stalenessBudgetDays),
          retired,
          retiredAt: s.retiredAt ?? null,
        };
      });
  }

  async getBackfilledSeries(): Promise<Set<string>> {
    return new Set(this.backfilled.keys());
  }

  async markBackfilled(seriesIds: string[], at: string, since: IsoDate): Promise<void> {
    for (const id of seriesIds) this.backfilled.set(id, { at, since });
  }

  async putScores(scores: ScoreRecord[]): Promise<void> {
    for (const s of scores) this.scores.set(`${s.scoreDate}|${s.key}`, { ...s });
  }

  async getScores(scoreDate: IsoDate): Promise<ScoreRecord[]> {
    return [...this.scores.values()].filter((s) => s.scoreDate === scoreDate);
  }

  async getLatestScoreDate(): Promise<IsoDate | null> {
    const dates = [...this.scores.values()].map((s) => s.scoreDate).sort();
    return dates.at(-1) ?? null;
  }

  async getScoreHistory(key: string, from?: IsoDate): Promise<Array<{ scoreDate: IsoDate; value: number }>> {
    return [...this.scores.values()]
      .filter((s) => s.key === key && (!from || s.scoreDate >= from))
      .sort((a, b) => byteCompare(a.scoreDate, b.scoreDate))
      .map((s) => ({ scoreDate: s.scoreDate, value: s.value }));
  }

  async putEvents(events: WorldEvent[]): Promise<number> {
    for (const e of events) this.events.set(e.id, { ...e });
    return events.length;
  }

  async listEvents(filter: EventFilter = {}): Promise<WorldEvent[]> {
    return [...this.events.values()]
      .filter((e) => (!filter.category || e.category === filter.category) && (!filter.since || e.ts >= filter.since))
      // Ties broken by id, as in the SQL stores: GDELT stamps many events alike.
      .sort((a, b) => byteCompare(b.ts, a.ts) || byteCompare(a.id, b.id))
      .slice(0, filter.limit ?? 200);
  }

  async close(): Promise<void> { this.closed = true; }

  /* ----------------------------------------------------------- test helpers */

  /** Every run recorded, in write order — `getLatestRuns` only shows the last. */
  allRuns(): SourceRun[] { return [...this.runs]; }
  allPipelineRuns(): PipelineRun[] { return [...this.pipeline]; }
}

/**
 * Newest first, ties broken by id. `daily` and the `ingest` it wraps start in
 * the same millisecond, so without the tiebreak their order is whatever the
 * engine happens to return — and differs between SQLite and Postgres.
 */
function newestFirst(a: PipelineRun, b: PipelineRun): number {
  return byteCompare(b.startedAt, a.startedAt) || (b.id ?? 0) - (a.id ?? 0);
}

/**
 * Code-unit order, which is what SQLite and the C-collated Postgres columns
 * use. `localeCompare` ignores punctuation, so it put `us_a` before `us.a_b`
 * and made this double disagree with every real store about id order.
 */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
