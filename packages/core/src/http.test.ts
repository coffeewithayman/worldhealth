import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Http, HttpError, parseRetryAfter, redactUrl } from './http.js';
import { createLogger } from './log.js';
import { MemoryCache } from './cache.js';

const quiet = createLogger('test', { level: 'silent' });

function client(cache = new MemoryCache(), noCache = false): Http {
  return new Http(cache, 'test-source', {
    defaultCacheTtlHours: 12,
    userAgent: 'test',
    noCache,
    logger: quiet,
  });
}

/** Replace global fetch with a scripted sequence, restoring it afterwards. */
function stubFetch(responses: Array<Response | (() => Response)>): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const ok = (body: string) => () => new Response(body, { status: 200 });
const status = (code: number) => () => new Response('', { status: code });

/* ------------------------------------------------------------------ redaction */

test('redactUrl blanks every credential-shaped query parameter', () => {
  assert.equal(
    redactUrl('https://api.example.com/x?series_id=M2SL&api_key=abc123'),
    'https://api.example.com/x?series_id=M2SL&api_key=REDACTED',
  );
  assert.equal(
    redactUrl('https://api.example.com/x?token=abc&access_token=def'),
    'https://api.example.com/x?token=REDACTED&access_token=REDACTED',
  );
});

test('redactUrl leaves a clean url byte-identical', () => {
  // Rewriting through URL would reorder parameters and re-encode them, which
  // makes two log lines for the same request look like different requests.
  const url = 'https://api.example.com/data?series_id=M2SL&observation_start=2020-01-01';
  assert.equal(redactUrl(url), url);
});

test('an unparseable string that looks credentialed is dropped entirely', () => {
  assert.equal(redactUrl('not a url key=abc'), '[redacted url]');
  assert.equal(redactUrl('not a url'), 'not a url');
});

/* -------------------------------------------------------------------- retry */

test('a 429 is retried and the eventual body is returned', async () => {
  const f = stubFetch([status(429), ok('recovered')]);
  try {
    const body = await client().getText('https://x.test/a', { retries: 2, cacheTtlHours: 0 });
    assert.equal(body, 'recovered');
    assert.equal(f.calls.length, 2);
  } finally { f.restore(); }
});

test('minBackoffMs holds a retry back past the rate-limit window', async () => {
  // GDELT refuses a second request inside five seconds, so the default curve's
  // ~1s first retry is refused too and spends a request being refused. The
  // floor is the difference between a retry that can work and one that cannot.
  const f = stubFetch([status(429), ok('recovered')]);
  const t0 = Date.now();
  try {
    const body = await client().getText('https://x.test/a', {
      retries: 2, cacheTtlHours: 0, minBackoffMs: 300,
    });
    assert.equal(body, 'recovered');
    assert.ok(Date.now() - t0 >= 300, 'the retry must wait at least the configured floor');
  } finally { f.restore(); }
});

test('Retry-After is honoured over the backoff curve', async () => {
  const f = stubFetch([
    () => new Response('', { status: 429, headers: { 'retry-after': '0.4' } }),
    ok('recovered'),
  ]);
  const t0 = Date.now();
  try {
    assert.equal(await client().getText('https://x.test/a', { retries: 2, cacheTtlHours: 0 }), 'recovered');
    assert.ok(Date.now() - t0 >= 400, 'a server that states its wait knows better than our curve');
  } finally { f.restore(); }
});

test('parseRetryAfter reads both spellings and refuses to stall the pipeline', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter(null), 0);
  assert.equal(parseRetryAfter('not-a-date'), 0);
  // A date in the past means "now", not a negative sleep.
  assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
  // Capped: an hour from a misconfigured proxy must not freeze the stage.
  assert.equal(parseRetryAfter('86400'), 60_000);
});

test('a 403 is not retried — it is a bug in our request, not a transient fault', async () => {
  const f = stubFetch([status(403)]);
  try {
    await assert.rejects(
      () => client().getText('https://x.test/a', { retries: 3, cacheTtlHours: 0 }),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    );
    assert.equal(f.calls.length, 1, 'retrying a 403 just burns quota against a request that cannot work');
  } finally { f.restore(); }
});

test('the error a failed fetch throws never carries the key', async () => {
  // This message is persisted to `source_runs.error` and served by /api/sources.
  const f = stubFetch([status(404)]);
  try {
    await assert.rejects(
      () => client().getText('https://x.test/a?api_key=abcdef123456', { retries: 0, cacheTtlHours: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.doesNotMatch(err.message, /abcdef123456/);
        assert.match(err.message, /REDACTED/);
        return true;
      },
    );
  } finally { f.restore(); }
});

test('a status listed in emptyOn returns null rather than throwing', async () => {
  // A weekly file that is not published yet is not a broken connector.
  const f = stubFetch([status(404)]);
  try {
    const body = await client().getText('https://x.test/late.csv', { emptyOn: [404], cacheTtlHours: 0 });
    assert.equal(body, null);
  } finally { f.restore(); }
});

test('getJson reports the body it could not parse, not just "invalid json"', async () => {
  const f = stubFetch([ok('<html>rate limited</html>')]);
  try {
    await assert.rejects(
      () => client().getJson('https://x.test/a', { cacheTtlHours: 0 }),
      /rate limited/,
    );
  } finally { f.restore(); }
});

/* -------------------------------------------------------------------- cache */

test('a cached body is reused and the upstream is not hit again', async () => {
  const store = new MemoryCache();
  const f = stubFetch([ok('first'), ok('second')]);
  try {
    assert.equal(await client(store).getText('https://x.test/a'), 'first');
    assert.equal(await client(store).getText('https://x.test/a'), 'first');
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('--no-cache refetches even with a warm cache', async () => {
  const store = new MemoryCache();
  const f = stubFetch([ok('first'), ok('second')]);
  try {
    await client(store).getText('https://x.test/a');
    assert.equal(await client(store, true).getText('https://x.test/a'), 'second');
  } finally { f.restore(); }
});

test('the cached row stores the url without the credential', async () => {
  // `raw_cache` is replayability, and it is also a table someone will read.
  const store = new MemoryCache();
  const f = stubFetch([ok('body')]);
  try {
    await client(store).getText('https://x.test/a?api_key=abcdef123456');
    const cached = await store.get(store.keys()[0]!);
    assert.ok(cached);
    assert.doesNotMatch(cached!.url, /abcdef123456/);
    assert.match(cached!.url, /REDACTED/);
  } finally { f.restore(); }
});

test('concurrent requests for the same url share one fetch', async () => {
  const f = stubFetch([ok('body')]);
  try {
    const http = client();
    const [a, b] = await Promise.all([
      http.getText('https://x.test/same', { cacheTtlHours: 0 }),
      http.getText('https://x.test/same', { cacheTtlHours: 0 }),
    ]);
    assert.equal(a, 'body');
    assert.equal(b, 'body');
    assert.equal(f.calls.length, 1, 'two panels wanting the same series must not double the quota spend');
  } finally { f.restore(); }
});

test('a cache that is down costs a refetch, never the fetch itself', async () => {
  // In production the cache is an object store over the network.
  const failing = {
    get: async () => { throw new Error('S3 GET 503'); },
    put: async () => { throw new Error('S3 PUT 503'); },
    prune: async () => 0,
    describe: () => 's3 test',
  };
  const f = stubFetch([ok('fresh')]);
  try {
    const http = new Http(failing, 'test-source', { defaultCacheTtlHours: 12, userAgent: 'test', logger: quiet });
    assert.equal(await http.getText('https://x.test/a'), 'fresh');
  } finally { f.restore(); }
});
