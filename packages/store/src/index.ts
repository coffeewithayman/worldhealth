import { resolve } from 'node:path';
import { PostgresStore } from './postgres-store.js';
import { SqliteStore } from './sqlite-store.js';

export * from './migrations.js';
export * from './sqlite-store.js';
export * from './postgres-store.js';
export * from './copy.js';

/** Repo root, resolved from this file's location so it holds from any cwd. */
const ROOT = resolve(import.meta.dirname, '../../..');

export type StoreTarget =
  | { kind: 'postgres'; connectionString: string }
  | { kind: 'sqlite'; path: string };

/**
 * Which database the environment points at.
 *
 * `DATABASE_URL` is the one variable every host (Railway, Fly, Render, Heroku,
 * a compose file) already knows how to inject, so it is the production switch:
 * a `postgres://` URL selects Postgres. Without it the local SQLite file is
 * used, which keeps `npm run daily` on a laptop working with no setup.
 */
export function resolveStoreTarget(env: NodeJS.ProcessEnv = process.env): StoreTarget {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    if (/^postgres(ql)?:\/\//i.test(url)) return { kind: 'postgres', connectionString: url };
    const file = url.match(/^(?:sqlite|file):(?:\/\/)?(.+)$/i);
    if (file) return { kind: 'sqlite', path: resolve(file[1]!) };
    throw new Error('DATABASE_URL must be a postgres:// URL or a sqlite:<path>');
  }
  return { kind: 'sqlite', path: env.WD_DB_PATH ?? resolve(ROOT, 'data/world.db') };
}

/** Human-readable, credential-free description for logs and banners. */
export function describeStoreTarget(t: StoreTarget): string {
  if (t.kind === 'sqlite') return `sqlite ${t.path}`;
  try {
    const u = new URL(t.connectionString);
    return `postgres ${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return 'postgres';
  }
}

export function openStore(t: StoreTarget): SqliteStore | PostgresStore {
  return t.kind === 'postgres'
    ? new PostgresStore({ connectionString: t.connectionString })
    : new SqliteStore(t.path);
}

/** The store the environment points at. Callers still run `migrate()`. */
export function createStore(env: NodeJS.ProcessEnv = process.env): SqliteStore | PostgresStore {
  return openStore(resolveStoreTarget(env));
}
