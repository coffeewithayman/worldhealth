/**
 * Cloudflare Workers entry point for the read-only deployment.
 *
 * This is the whole server. The pipeline runs elsewhere (the existing Node CLI
 * on a schedule), `snapshot.ts` turns every API response into a file, and this
 * Worker's only job is to answer `/api/<route>` out of `api/<route>.json` in
 * the Static Assets bundle and let everything else fall through to the web
 * build. See `docs/deploy-cloudflare.md` §7 for why the pipeline is not here.
 *
 * Deliberately dependency-free — no `@wd/core`, no Hono. Every payload was
 * computed by the real routes at snapshot time, so there is nothing left to
 * compute at request time, and a Worker with no imports has no Node built-ins
 * to polyfill and nothing that can drift from the Node build.
 *
 * The consequence, recorded in `docs/deploy-cloudflare.md` §5: scores are *not*
 * computed live here. Editing `config/indicators.yaml` changes nothing until
 * the snapshot is rebuilt and redeployed. `?as_of=` is likewise inert — it is
 * ignored rather than honoured, because a query string does not select a file.
 */

/** Just the slice of the Static Assets binding this Worker uses. */
interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  ASSETS: AssetFetcher;
}

/**
 * Snapshots change once per pipeline run, so a minute at the edge costs at most
 * a minute of staleness on a dashboard whose inputs are daily at best.
 * `stale-if-error` is the important one: it keeps the last good payload serving
 * if a deploy half-lands.
 *
 * Note that this only takes effect behind a custom domain — `workers.dev` does
 * not apply CDN caching to Worker responses (`docs/deploy-cloudflare.md` §8).
 */
const API_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=600, stale-if-error=86400';

/** The shape `apiErrorHandler` returns, so the client sees one error format. */
function apiError(message: string, kind: string, path: string, status: number): Response {
  return new Response(JSON.stringify({ error: message, kind, path }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Not an API path: the web bundle. Hash routing means every deep link is
    // still a request for "/", so no SPA rewrite is needed here.
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return apiError(
        `${request.method} is not supported — this deployment serves a precomputed snapshot and is read-only.`,
        'read_only',
        url.pathname,
        405,
      );
    }

    // The client builds paths with encodeURIComponent (`api.series(id)` in
    // web/src/api.ts), and the snapshot writes files under the raw id. Decoding
    // here is what turns one back into the other.
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return apiError('Malformed path', 'bad_request', url.pathname, 400);
    }

    // A path that already ends in .json would let a caller reach the snapshot
    // file directly and bypass the headers below; treat it as not found so
    // there is exactly one way to read the API.
    if (decoded.endsWith('.json') || decoded.includes('..')) {
      return apiError(`No such route "${decoded}"`, 'not_found', decoded, 404);
    }

    const assetUrl = new URL(`${decoded}.json`, url.origin);
    const res = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));

    // A miss is not always a non-2xx. Under `not_found_handling:
    // "single-page-application"` the asset router answers a missing file with
    // *200 and index.html*, which would sail past an `res.ok` check and hand
    // the dashboard's `res.json()` a page of HTML to parse. This deployment
    // does not set that option — the web build uses hash routing and never
    // needs it — but the check costs nothing and the config outlives the memory
    // of why it was safe.
    const servedHtml = (res.headers.get('content-type') ?? '').includes('html');
    if (!res.ok || servedHtml) {
      return apiError(
        `No snapshot for "${decoded}". It may be a route this deployment does not precompute, or the snapshot may be out of date.`,
        'not_found',
        decoded,
        404,
      );
    }

    const headers = new Headers(res.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', API_CACHE_CONTROL);
    // The dashboard is a read-only public payload; this keeps it usable from a
    // local dev bundle pointed at the deployed API.
    headers.set('access-control-allow-origin', '*');

    return new Response(request.method === 'HEAD' ? null : res.body, { status: 200, headers });
  },
};
