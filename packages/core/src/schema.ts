/**
 * Database schema.
 *
 * Portability rule: plain SQL only, valid in SQLite, Postgres AND Cloudflare D1.
 * Concretely that means `INSERT ... ON CONFLICT DO UPDATE` (never SQLite's
 * `INSERT OR REPLACE`), TEXT for dates and timestamps, and no SQLite
 * extensions. Keeping to this now is nearly free; retrofitting it later is not.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS series (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    unit                  TEXT NOT NULL,
    cadence               TEXT NOT NULL,
    source_id             TEXT NOT NULL,
    pillar                TEXT,
    source_url            TEXT,
    notes                 TEXT,
    staleness_budget_days INTEGER NOT NULL DEFAULT 7,
    retired_at            TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_series_source ON series (source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_series_pillar ON series (pillar)`,

  `CREATE TABLE IF NOT EXISTS observations (
    series_id TEXT NOT NULL,
    obs_date  TEXT NOT NULL,
    value     REAL NOT NULL,
    PRIMARY KEY (series_id, obs_date)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_obs_date ON observations (obs_date)`,

  `CREATE TABLE IF NOT EXISTS source_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id     TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL,
    status        TEXT NOT NULL,
    rows_written  INTEGER NOT NULL DEFAULT 0,
    events_written INTEGER NOT NULL DEFAULT 0,
    error         TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_runs_source ON source_runs (source_id, started_at DESC)`,

  // One row per pipeline stage execution, written even when the stage throws.
  // Without it a scheduler that stopped firing is invisible: every per-source
  // row keeps reporting the success it had on the last day the job ran.
  `CREATE TABLE IF NOT EXISTS pipeline_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    stage         TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL,
    status        TEXT NOT NULL,
    ok_count      INTEGER NOT NULL DEFAULT 0,
    fail_count    INTEGER NOT NULL DEFAULT 0,
    rows_written  INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    detail        TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON pipeline_runs (stage, started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS series_health (
    series_id       TEXT PRIMARY KEY,
    last_obs_date   TEXT,
    last_success_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS scores (
    score_date TEXT NOT NULL,
    key        TEXT NOT NULL,
    kind       TEXT NOT NULL,
    value      REAL NOT NULL,
    inputs     TEXT NOT NULL,
    PRIMARY KEY (score_date, key)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_scores_kind ON scores (kind, score_date DESC)`,

  `CREATE TABLE IF NOT EXISTS events (
    id        TEXT PRIMARY KEY,
    ts        TEXT NOT NULL,
    source_id TEXT NOT NULL,
    category  TEXT NOT NULL,
    headline  TEXT NOT NULL,
    url       TEXT NOT NULL,
    severity  REAL NOT NULL DEFAULT 0,
    entities  TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_category ON events (category, ts DESC)`,

  // Verbatim upstream responses. Makes ingest replayable after a parsing or
  // scoring bug without re-hitting rate-limited APIs, and lets the golden
  // fixture tests run entirely offline.
  `CREATE TABLE IF NOT EXISTS raw_cache (
    cache_key   TEXT PRIMARY KEY,
    source_id   TEXT NOT NULL,
    url         TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    body        TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_raw_cache_source ON raw_cache (source_id, fetched_at DESC)`,
];

/**
 * Columns added to a table that already exists in the wild.
 *
 * `CREATE TABLE IF NOT EXISTS` above does nothing to a database created before
 * a column was introduced, so every new column has to be declared here too or
 * it only ever reaches fresh checkouts. Kept as data rather than DDL because
 * the "add it only if it is missing" spelling is the one piece of schema
 * handling that genuinely differs between SQLite, Postgres and D1 — each store
 * applies this list in its own dialect, and the list itself stays portable.
 */
export interface AddedColumn {
  table: string;
  column: string;
  /** Type and any default, exactly as it appears after the column name. */
  definition: string;
}

export const ADDED_COLUMNS: AddedColumn[] = [
  { table: 'series', column: 'retired_at', definition: 'TEXT' },
];
