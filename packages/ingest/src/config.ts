import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Repo root, resolved from this file's location so the CLI works from any cwd. */
export const ROOT = resolve(import.meta.dirname, '../../..');

export function dbPath(): string {
  return process.env.WD_DB_PATH ?? resolve(ROOT, 'data/world.db');
}

/**
 * Load `.env.local` then `.env` into `process.env` without adding a dependency.
 * First writer wins, so the precedence is: real environment > `.env.local` >
 * `.env`. That means `FRED_API_KEY=x npm run ingest` overrides both files, and
 * `.env.local` (machine-specific, gitignored) overrides the shared `.env`.
 *
 * An empty value is treated as absent, so a placeholder line left over from
 * `.env.example` in one file does not mask a real key in the other.
 */
export function loadEnv(): void {
  for (const name of ['.env.local', '.env']) {
    const path = resolve(ROOT, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value) continue;
      if (!process.env[key]) process.env[key] = value;
    }
  }
}
