import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createLogger, describeError, scrubSecrets, type LogLevel } from './log.js';

/** A logger writing into an array instead of stderr. */
function capture(level: LogLevel = 'debug', format: 'text' | 'json' = 'json') {
  const lines: string[] = [];
  const logger = createLogger('test', { level, format, sink: (l) => lines.push(l) });
  return { logger, lines, json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/* -------------------------------------------------------------------- levels */

test('a line below the configured level is not written', () => {
  const { logger, lines } = capture('warn');
  logger.debug('ignored');
  logger.info('ignored');
  logger.warn('kept');
  logger.error('kept');
  assert.equal(lines.length, 2);
});

test('silent writes nothing at all', () => {
  const { logger, lines } = capture('silent');
  logger.error('not even this');
  assert.equal(lines.length, 0);
});

test('enabled() lets a call site skip building fields it would throw away', () => {
  const { logger } = capture('warn');
  assert.equal(logger.enabled('debug'), false);
  assert.equal(logger.enabled('error'), true);
});

/* -------------------------------------------------------------------- shape */

test('json lines carry the fields a log shipper needs', () => {
  const { logger, json } = capture();
  logger.info('ingested', { source: 'fred', rows: 412 });
  const [line] = json();
  assert.equal(line!.level, 'info');
  assert.equal(line!.scope, 'test');
  assert.equal(line!.msg, 'ingested');
  assert.equal(line!.source, 'fred');
  assert.equal(line!.rows, 412);
  assert.match(String(line!.ts), /^\d{4}-\d{2}-\d{2}T/);
});

test('a child logger nests the scope and inherits its bound fields', () => {
  const { logger, json } = capture();
  logger.child('connector', { source: 'bis' }).warn('partial', { rows: 0 });
  const [line] = json();
  assert.equal(line!.scope, 'test.connector');
  assert.equal(line!.source, 'bis', 'bound fields travel with every line from the child');
  assert.equal(line!.rows, 0);
});

test('text format stays on one line and names the scope', () => {
  const { logger, lines } = capture('debug', 'text');
  logger.child('stage').info('started', { stage: 'derive' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.includes('\n'), false);
  assert.match(lines[0]!, /test\.stage/);
  assert.match(lines[0]!, /stage=derive/);
});

/* -------------------------------------------------------------------- errors */

test('an Error field becomes name and message, with the stack only on error lines', () => {
  const { logger, json } = capture();
  const err = new TypeError('cannot read length of undefined');
  logger.warn('recovered', { err });
  logger.error('failed', { err });
  const [warned, failed] = json();

  const w = warned!.err as Record<string, unknown>;
  assert.equal(w.name, 'TypeError');
  assert.equal(w.message, 'cannot read length of undefined');
  // A warning is by definition something the run survived. A stack under each
  // one buries the twenty other warnings around it.
  assert.equal(w.stack, undefined);
  assert.ok((failed!.err as Record<string, unknown>).stack, 'an error line keeps the stack');
});

test('describeError handles the things that get thrown that are not Errors', () => {
  assert.equal(describeError(new Error('boom')).message, 'boom');
  assert.equal(describeError('boom').message, 'boom');
  assert.equal(describeError({ code: 42 }).message, '{"code":42}');
});

/* ------------------------------------------------------------------ secrets */

test('a key in a url field is redacted', () => {
  const { logger, json } = capture();
  logger.info('fetched', { url: 'https://api.stlouisfed.org/fred/series?series_id=M2SL&api_key=abcdef123456' });
  assert.match(String(json()[0]!.url), /api_key=REDACTED/);
  assert.doesNotMatch(String(json()[0]!.url), /abcdef123456/);
});

test('a key quoted inside a message from somewhere else is still scrubbed', () => {
  // The case `redactUrl` cannot catch: an upstream error, or a library, echoing
  // the credential back in prose we did not write.
  const { logger, lines } = capture();
  logger.error('upstream rejected the request', { body: 'Bad Request: api_key=abcdef123456 is not valid' });
  assert.doesNotMatch(lines[0]!, /abcdef123456/);
  assert.match(lines[0]!, /api_key=REDACTED/);
});

test('the literal value of a credential env var never survives a log line', () => {
  // Connector errors are persisted and served over HTTP. A key that reaches a
  // log line is a key in the console, the journal, the database and the API at
  // once, so this is belt and braces over every call site remembering.
  const secret = 'zzq-not-a-real-key-9713';
  process.env.WD_TEST_API_KEY = secret;
  try {
    const { logger, lines } = capture();
    logger.error('failed', { detail: `sent ${secret} and got 403` });
    assert.doesNotMatch(lines[0]!, /zzq-not-a-real-key/);
    assert.match(lines[0]!, /REDACTED/);
  } finally {
    delete process.env.WD_TEST_API_KEY;
  }
});

test('scrubbing leaves ordinary environment values alone', () => {
  // Blanking every env value would turn the log into REDACTED soup — the rule
  // is the variable's *name*, and a short value is not a credential.
  process.env.WD_TEST_REGION = 'us-east-1';
  process.env.WD_TEST_KEY = 'ab';
  try {
    assert.equal(scrubSecrets('deployed to us-east-1'), 'deployed to us-east-1');
    assert.equal(scrubSecrets('two letters: ab'), 'two letters: ab');
  } finally {
    delete process.env.WD_TEST_REGION;
    delete process.env.WD_TEST_KEY;
  }
});

/* -------------------------------------------------------------- environment */

test('the level is read per line, so .env loaded after import still applies', () => {
  // Module-level loggers are constructed before `loadEnv()` runs. Capturing the
  // level at construction would make WD_LOG_LEVEL in .env.local do nothing.
  const lines: string[] = [];
  const logger = createLogger('test', { format: 'json', sink: (l) => lines.push(l) });
  const before = process.env.WD_LOG_LEVEL;
  try {
    process.env.WD_LOG_LEVEL = 'error';
    logger.info('dropped');
    process.env.WD_LOG_LEVEL = 'debug';
    logger.info('kept');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).msg, 'kept');
  } finally {
    if (before === undefined) delete process.env.WD_LOG_LEVEL;
    else process.env.WD_LOG_LEVEL = before;
  }
});
