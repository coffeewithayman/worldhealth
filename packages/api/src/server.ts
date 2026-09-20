import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { log, SqliteStore } from '@wd/core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { apiErrorHandler, createRoutes } from './routes.js';

const logger = log.child('server');

const ROOT = resolve(import.meta.dirname, '../../..');
const dbPath = process.env.WD_DB_PATH ?? resolve(ROOT, 'data/world.db');
const configPath = process.env.WD_CONFIG_PATH ?? resolve(ROOT, 'config/indicators.yaml');
const port = Number(process.env.PORT ?? 8787);

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Run "npm run migrate && npm run ingest" first.`);
  process.exit(1);
}

const store = new SqliteStore(dbPath);
// Idempotent DDL, and the API is often the first process to run after a pull
// that added a table. Without this the server reads a schema older than its own
// code and fails on a query for a table the CLI has not created yet.
await store.migrate();

const app = new Hono();
app.route('/', createRoutes({ store, configPath }));
// A mounted sub-app's error handler does not apply to the app it is mounted
// into, so the parent needs its own copy or route failures go unlogged.
app.onError(apiErrorHandler);

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
  logger.info('listening', { port: info.port, dbPath, configPath, web: existsSync(webDist) });
});

// Nothing else would report these: an unhandled rejection in a route already
// goes through the error handler, but one in a background task would otherwise
// print a bare stack to stderr and leave no trace of which process it came from.
process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { err });
  void store.close().finally(() => process.exit(1));
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    logger.info('shutting down', { signal: sig });
    void store.close().then(() => process.exit(0));
  });
}
