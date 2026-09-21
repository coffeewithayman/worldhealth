import type { PostgresStore } from './postgres-store.js';
import { COPYABLE_TABLES, type SqliteStore } from './sqlite-store.js';

export interface CopyProgress {
  table: string;
  copied: number;
  total: number;
}

/**
 * One-off initial load: every table of a local SQLite database into Postgres.
 *
 * `raw_cache` is deliberately not copied — it is replayability, not data, and
 * refills itself; carrying it would roughly triple the transfer. Rows already
 * present in the target are left alone (`ON CONFLICT DO NOTHING`), so a re-run
 * after production has started writing never overwrites newer data with the
 * older local copy.
 *
 * Both stores must already be migrated, so their columns line up.
 */
export async function copyStore(
  source: SqliteStore,
  target: PostgresStore,
  onProgress: (p: CopyProgress) => void = () => {},
  batchSize = 20_000,
): Promise<Array<{ table: string; rows: number }>> {
  const out: Array<{ table: string; rows: number }> = [];
  for (const table of COPYABLE_TABLES) {
    const total = source.countRows(table);
    let copied = 0;
    let batch: Array<Record<string, unknown>> = [];
    for (const row of source.iterateTable(table)) {
      batch.push(row);
      if (batch.length >= batchSize) {
        await target.insertRaw(table, batch);
        copied += batch.length;
        batch = [];
        onProgress({ table, copied, total });
      }
    }
    if (batch.length) {
      await target.insertRaw(table, batch);
      copied += batch.length;
      onProgress({ table, copied, total });
    }
    if (table === 'source_runs' || table === 'pipeline_runs') await target.resetIdentity(table);
    out.push({ table, rows: copied });
  }
  return out;
}
