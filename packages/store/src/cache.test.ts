import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AwsClient } from 'aws4fetch';
import { MemoryCache, NullCache, type CachedResponse, type ResponseCache } from '@wd/core';
import { FsCache, S3Cache, createCache } from './cache.js';

/**
 * Every `ResponseCache`, against the same assertions.
 *
 * S3 cases run when `WD_TEST_S3_ENDPOINT` points at an S3-compatible server
 * (CI and local use MinIO; credentials in `WD_TEST_S3_ACCESS_KEY_ID` /
 * `WD_TEST_S3_SECRET_ACCESS_KEY`). Each case gets its own key prefix.
 */
const S3 = process.env.WD_TEST_S3_ENDPOINT
  ? {
    endpoint: process.env.WD_TEST_S3_ENDPOINT,
    accessKeyId: process.env.WD_TEST_S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.WD_TEST_S3_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.WD_TEST_S3_BUCKET ?? 'wd-test',
  }
  : null;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'wd-cache-'));
  dirs.push(d);
  return d;
}

before(async () => {
  if (!S3) return;
  // Create the bucket; 409 means an earlier run already did.
  const aws = new AwsClient({ ...S3, service: 's3', region: 'us-east-1' });
  const res = await aws.fetch(`${S3.endpoint}/${S3.bucket}`, { method: 'PUT' });
  await res.body?.cancel();
  if (!res.ok && res.status !== 409) throw new Error(`could not create test bucket: ${res.status}`);
});

after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let seq = 0;
function caches(): Array<{ name: string; make: () => ResponseCache }> {
  const out: Array<{ name: string; make: () => ResponseCache }> = [
    { name: 'MemoryCache', make: () => new MemoryCache() },
    { name: 'FsCache', make: () => new FsCache(join(tmp(), 'cache')) },
  ];
  if (S3) {
    out.push({
      name: 'S3Cache',
      make: () => new S3Cache({
        ...S3, region: 'us-east-1', prefix: `t${process.pid}-${Date.now().toString(36)}-${seq++}/`,
      }),
    });
  }
  return out;
}

function forEachCache(name: string, body: (c: ResponseCache) => Promise<void>): void {
  for (const c of caches()) test(`${name} [${c.name}]`, () => body(c.make()));
}

function entry(key: string, over: Partial<CachedResponse> = {}): CachedResponse {
  return {
    cacheKey: key,
    sourceId: 'fred',
    url: 'https://api.stlouisfed.org/fred/series/observations?series_id=M2SL&api_key=REDACTED',
    fetchedAt: new Date().toISOString(),
    body: '{"observations":[{"date":"2026-09-01","value":"21000.1"}]}',
    ...over,
  };
}

forEachCache('an entry round-trips byte for byte', async (cache) => {
  // Replay is the point: the bytes that come back must be the bytes fetched.
  const body = 'date,value\n2026-09-01,1.25\n' + 'é'.repeat(5000) + '\u0000';
  await cache.put(entry('a1b2c3', { body }));
  const got = await cache.get('a1b2c3');
  assert.equal(got?.body, body);
  assert.equal(got?.sourceId, 'fred');
  assert.match(got!.url, /REDACTED/);
});

forEachCache('a missing key is a miss, not an error', async (cache) => {
  assert.equal(await cache.get('deadbeef'), null);
});

forEachCache('a second put replaces the first', async (cache) => {
  await cache.put(entry('k1', { body: 'old' }));
  await cache.put(entry('k1', { body: 'new' }));
  assert.equal((await cache.get('k1'))?.body, 'new');
});

forEachCache('prune removes what is older than the cutoff and keeps the rest', async (cache) => {
  await cache.put(entry('keep', { fetchedAt: new Date().toISOString() }));
  await cache.put(entry('drop', { fetchedAt: '2020-01-01T00:00:00.000Z' }));
  // File and object stores judge age by modification time, which is "now" for
  // both writes; backdate the old one the way each store would see it.
  if (cache instanceof FsCache) {
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(cache.dir, 'drop.json.gz'), old, old);
    const removed = await cache.prune(new Date(Date.now() - 86_400_000));
    assert.equal(removed, 1);
  } else if (cache instanceof S3Cache) {
    // An object's LastModified cannot be backdated, so prune everything
    // written before a moment just after both puts.
    await new Promise((r) => setTimeout(r, 1100));
    const cutoff = new Date();
    await cache.put(entry('later'));
    assert.equal(await cache.prune(cutoff), 2);
    assert.equal(await cache.get('keep'), null);
    assert.equal((await cache.get('later'))?.body, entry('x').body);
    return;
  } else {
    assert.equal(await cache.prune(new Date(Date.now() - 86_400_000)), 1);
  }
  assert.equal(await cache.get('drop'), null);
  assert.ok(await cache.get('keep'));
});

forEachCache('a key that could escape its directory is refused', async (cache) => {
  if (cache instanceof MemoryCache) return;
  await assert.rejects(cache.put(entry('../../etc/passwd')), /Unsafe cache key/);
});

test('FsCache stores entries compressed', async () => {
  const cache = new FsCache(join(tmp(), 'c'));
  await cache.put(entry('big', { body: 'x'.repeat(100_000) }));
  const [name] = readdirSync(cache.dir);
  assert.equal(name, 'big.json.gz');
});

test('NullCache keeps nothing', async () => {
  const c = new NullCache();
  await c.put(entry('k'));
  assert.equal(await c.get('k'), null);
});

/* ------------------------------------------------------------------ factory */

test('WD_CACHE_URL picks the cache, defaulting to a directory in the repo', () => {
  assert.match(createCache({}).describe(), /^file .*data\/cache$/);
  assert.equal(createCache({ WD_CACHE_URL: 'none' }).describe(), 'none');
  assert.equal(createCache({ WD_CACHE_URL: 'memory' }).describe(), 'memory');
  assert.equal(createCache({ WD_CACHE_URL: 'file:/var/cache/wd' }).describe(), 'file /var/cache/wd');

  const s3 = createCache({
    WD_CACHE_URL: 's3://wd-cache/raw',
    S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    S3_SECRET_ACCESS_KEY: 'secret-example-value',
    S3_REGION: 'auto',
  });
  assert.equal(s3.describe(), 's3 acct.r2.cloudflarestorage.com/wd-cache/raw/');
  assert.doesNotMatch(s3.describe(), /secret-example-value/);
});

test('an S3 cache without credentials refuses to start rather than failing every fetch', () => {
  assert.throws(() => createCache({ WD_CACHE_URL: 's3://wd-cache' }), /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
});
