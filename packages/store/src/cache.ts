import { AwsClient } from 'aws4fetch';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MemoryCache, NullCache, type CachedResponse, type ResponseCache } from '@wd/core';

/**
 * `ResponseCache` implementations that touch the outside world, and the
 * factory that picks one from `WD_CACHE_URL`.
 *
 * Entries are stored as gzipped JSON — upstream bodies are mostly XML, CSV and
 * JSON and shrink ~8×, and the object carries its own `fetchedAt`, `sourceId`
 * and redacted `url` so no index is needed beside it.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function encode(entry: CachedResponse): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(entry)));
}

function decode(buf: Uint8Array): CachedResponse | null {
  try {
    return JSON.parse(gunzipSync(buf).toString('utf8')) as CachedResponse;
  } catch {
    // A torn or foreign object is a miss, not a crash: the fetch it stood in
    // for is always available.
    return null;
  }
}

/** Keys come from a sha256 in `Http`; anything else is refused rather than used as a path. */
function safeKey(key: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new Error(`Unsafe cache key: ${key}`);
  return key;
}

/* ------------------------------------------------------------------ files */

/** A directory of `<key>.json.gz` files — the local default (`data/cache`). */
export class FsCache implements ResponseCache {
  constructor(readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${safeKey(key)}.json.gz`);
  }

  async get(cacheKey: string): Promise<CachedResponse | null> {
    try {
      return decode(await readFile(this.path(cacheKey)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(entry: CachedResponse): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const final = this.path(entry.cacheKey);
    // Write-then-rename, so a reader never sees half an entry.
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, encode(entry));
    await rename(tmp, final);
  }

  async prune(before: Date): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let n = 0;
    for (const name of names) {
      if (!name.endsWith('.json.gz') && !name.endsWith('.tmp')) continue;
      const p = join(this.dir, name);
      const s = await stat(p).catch(() => null);
      if (s && s.mtime < before) { await unlink(p).catch(() => {}); n++; }
    }
    return n;
  }

  describe(): string { return `file ${this.dir}`; }
}

/* --------------------------------------------------------------------- s3 */

export interface S3CacheOptions {
  /** e.g. `https://<account>.r2.cloudflarestorage.com`, `http://localhost:9000`. */
  endpoint: string;
  bucket: string;
  /** Key prefix inside the bucket, `""` or ending in `/`. */
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `bucket.host/key` rather than `host/bucket/key`. Path style is the default: every S3-compatible store accepts it. */
  virtualHosted?: boolean;
}

/**
 * Any S3-compatible object store: AWS S3, Cloudflare R2, Railway Buckets,
 * MinIO, Tigris. Signed with `aws4fetch` (SigV4 over `fetch`, ~2 KiB) rather
 * than the AWS SDK, which would be the largest dependency in the repo by far.
 */
export class S3Cache implements ResponseCache {
  private client: AwsClient;
  private base: string;

  constructor(private opts: S3CacheOptions) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: opts.region,
    });
    const u = new URL(opts.endpoint);
    this.base = opts.virtualHosted
      ? `${u.protocol}//${opts.bucket}.${u.host}`
      : `${u.protocol}//${u.host}/${encodeURIComponent(opts.bucket)}`;
  }

  private objectUrl(key: string): string {
    const path = `${this.opts.prefix}${safeKey(key)}.json.gz`;
    return `${this.base}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async get(cacheKey: string): Promise<CachedResponse | null> {
    const res = await this.client.fetch(this.objectUrl(cacheKey), { method: 'GET' });
    if (res.status === 404) { await res.body?.cancel(); return null; }
    if (!res.ok) throw new Error(`S3 GET ${res.status} for cache key ${cacheKey}`);
    return decode(new Uint8Array(await res.arrayBuffer()));
  }

  async put(entry: CachedResponse): Promise<void> {
    const res = await this.client.fetch(this.objectUrl(entry.cacheKey), {
      method: 'PUT',
      body: new Uint8Array(encode(entry)),
      headers: { 'content-type': 'application/gzip' },
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`S3 PUT ${res.status} for cache key ${entry.cacheKey}`);
  }

  /** Every object under the prefix, with its LastModified. */
  private async *list(): AsyncGenerator<{ key: string; lastModified: Date }> {
    let token: string | undefined;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix: this.opts.prefix });
      if (token) q.set('continuation-token', token);
      const res = await this.client.fetch(`${this.base}/?${q}`, { method: 'GET' });
      const xml = await res.text();
      if (!res.ok) throw new Error(`S3 LIST ${res.status}: ${xml.slice(0, 200)}`);
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
        const lm = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
        if (key && lm) yield { key: unescapeXml(key), lastModified: new Date(lm) };
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]
        : undefined;
      if (token) token = unescapeXml(token);
    } while (token);
  }

  async prune(before: Date): Promise<number> {
    const doomed: string[] = [];
    for await (const o of this.list()) if (o.lastModified < before) doomed.push(o.key);
    // Single DELETEs rather than DeleteObjects: that call demands a Content-MD5
    // some S3-compatible stores reject, and a daily prune is a few hundred keys.
    let n = 0;
    const queue = [...doomed];
    const worker = async (): Promise<void> => {
      for (let key = queue.shift(); key; key = queue.shift()) {
        const url = `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
        const res = await this.client.fetch(url, { method: 'DELETE' });
        await res.body?.cancel();
        if (res.ok || res.status === 404) n++;
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return n;
  }

  describe(): string {
    return `s3 ${new URL(this.opts.endpoint).host}/${this.opts.bucket}/${this.opts.prefix}`;
  }
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/* ---------------------------------------------------------------- factory */

/**
 * The cache the environment asks for.
 *
 * `WD_CACHE_URL`:
 * - unset          → `data/cache` in the repo (local default)
 * - `none`         → nothing is kept
 * - `memory`       → per-process, for tests
 * - `file:<dir>` or a path → that directory
 * - `s3://bucket/prefix` → S3-compatible store, with `S3_ENDPOINT`,
 *   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (`AWS_*` names also accepted),
 *   optional `S3_REGION` (default `us-east-1`; R2 wants `auto`) and
 *   `S3_URL_STYLE=virtual`.
 *
 * The same names on every host; a platform's own bucket variables are mapped
 * onto them in its config rather than read here.
 */
export function createCache(env: NodeJS.ProcessEnv = process.env): ResponseCache {
  const raw = env.WD_CACHE_URL?.trim();
  if (!raw) return new FsCache(resolve(REPO_ROOT, 'data/cache'));
  if (/^(none|off|false)$/i.test(raw)) return new NullCache();
  if (raw === 'memory') return new MemoryCache();

  if (/^s3:\/\//i.test(raw)) {
    const u = new URL(raw);
    const bucket = u.hostname;
    const path = u.pathname.replace(/^\/+/, '');
    const prefix = path && !path.endsWith('/') ? `${path}/` : path;
    const endpoint = env.S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
    const region = env.S3_REGION ?? env.AWS_REGION ?? 'us-east-1';
    const accessKeyId = env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
    const missing = [
      !bucket && 'a bucket in WD_CACHE_URL',
      !accessKeyId && 'S3_ACCESS_KEY_ID',
      !secretAccessKey && 'S3_SECRET_ACCESS_KEY',
    ].filter(Boolean);
    if (missing.length) throw new Error(`WD_CACHE_URL=${raw} needs ${missing.join(', ')}`);
    return new S3Cache({
      endpoint: endpoint ?? `https://s3.${region}.amazonaws.com`,
      bucket,
      prefix,
      region,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      virtualHosted: env.S3_URL_STYLE === 'virtual',
    });
  }

  const dir = raw.replace(/^file:(\/\/)?/i, '');
  return new FsCache(resolve(dir));
}
