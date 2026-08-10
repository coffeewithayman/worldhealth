import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { SqliteStore } from '@wd/core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoutes } from './routes.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const dbPath = process.env.WD_DB_PATH ?? resolve(ROOT, 'data/world.db');
const configPath = process.env.WD_CONFIG_PATH ?? resolve(ROOT, 'config/indicators.yaml');
const port = Number(process.env.PORT ?? 8787);

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Run "npm run migrate && npm run ingest" first.`);
  process.exit(1);
}

const store = new SqliteStore(dbPath);
const app = new Hono();
app.route('/', createRoutes({ store, configPath }));

// Serve the built dashboard when it exists; in development Vite serves it
// instead and proxies /api here.
const webDist = resolve(ROOT, 'packages/web/dist');
if (existsSync(webDist)) {
  app.use('/*', serveStatic({ root: 'packages/web/dist' }));
  app.get('*', serveStatic({ path: 'packages/web/dist/index.html' }));
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`world-dashboard API on http://localhost:${info.port}`);
  console.log(`  db     ${dbPath}`);
  console.log(`  config ${configPath}`);
  if (!existsSync(webDist)) console.log('  (web bundle not built — run "npm run web" for the dev server)');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void store.close().then(() => process.exit(0)); });
}
