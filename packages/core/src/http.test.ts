import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Http, HttpError, redactUrl } from './http.js';
import { createLogger } from './log.js';
import { MemoryStore } from './memory-store.js';

const quiet = createLogger('test', { level: 'silent' });

function client(store = new MemoryStore(), noCache = false): Http {
  return new Http(store, 'test-source', {
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
  const store = new MemoryStore();
  const f = stubFetch([ok('first'), ok('second')]);
  try {
    assert.equal(await client(store).getText('https://x.test/a'), 'first');
    assert.equal(await client(store).getText('https://x.test/a'), 'first');
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('--no-cache refetches even with a warm cache', async () => {
  const store = new MemoryStore();
  const f = stubFetch([ok('first'), ok('second')]);
  try {
    await client(store).getText('https://x.test/a');
    assert.equal(await client(store, true).getText('https://x.test/a'), 'second');
  } finally { f.restore(); }
});

test('the cached row stores the url without the credential', async () => {
  // `raw_cache` is replayability, and it is also a table someone will read.
  const store = new MemoryStore();
  const f = stubFetch([ok('body')]);
  try {
    await client(store).getText('https://x.test/a?api_key=abcdef123456');
    const cached = await store.cacheGet(store.cacheKeys()[0]!);
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
