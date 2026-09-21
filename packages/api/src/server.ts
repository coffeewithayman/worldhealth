import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { defaultConfigPath, loadEnv, log, REPO_ROOT } from '@wd/core';
import { describeStoreTarget, openStore, resolveStoreTarget } from '@wd/store';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { apiErrorHandler, createRoutes } from './routes.js';

const logger = log.child('server');

// Keys in .env.local reach the API too, so the Sources tab reports the same
// key status as `npm run sources`. On a platform neither file exists.
loadEnv();
const configPath = defaultConfigPath();
const port = Number(process.env.PORT ?? 8787);

const target = resolveStoreTarget();
const dbLabel = describeStoreTarget(target);
// A missing local file means nobody has loaded data yet; an empty dashboard
// would hide that. Postgres has no such tell, and an empty one is legitimate
// before the first cron run.
if (target.kind === 'sqlite' && !existsSync(target.path)) {
  console.error(`No database at ${target.path}. Run "npm run migrate && npm run ingest" first.`);
  process.exit(1);
}

const store = openStore(target);
// Idempotent and locked, and the API is often the first process to run after
// a deploy that added a migration. Without this the server reads a schema
// older than its own code.
await store.migrate();

const app = new Hono();
app.route('/', createRoutes({ store, configPath }));
// A mounted sub-app's error handler does not apply to the app it is mounted
// into, so the parent needs its own copy or route failures go unlogged.
app.onError(apiErrorHandler);

// Serve the built dashboard when it exists; in development Vite serves it
// instead and proxies /api here.
// serveStatic resolves against the cwd, so the path is made relative to
// wherever the process was started rather than assuming the repo root.
const webDist = resolve(REPO_ROOT, 'packages/web/dist');
if (existsSync(webDist)) {
  const root = relative(process.cwd(), webDist) || '.';
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ path: `${root}/index.html` }));
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`world-dashboard API on http://localhost:${info.port}`);
  console.log(`  db     ${dbLabel}`);
  console.log(`  config ${configPath}`);
  if (!existsSync(webDist)) console.log('  (web bundle not built — run "npm run web" for the dev server)');
  logger.info('listening', { port: info.port, db: dbLabel, configPath, web: existsSync(webDist) });
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
