const axios = require('axios');
const Bottleneck = require('bottleneck');
const { buildAuth, manageAuth } = require('../auth/authManager');
const logger = require('../utils/logger');

const BASE_URL = 'https://api.vanta.com';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const MAX_PAGES = 50;
const PAGE_SIZE = 100;

// Retry-After bounds. Minimum prevents a past-date / "0" / negative from
// producing a tight retry loop. Maximum bounds the damage from a hostile or
// buggy upstream returning e.g. `Retry-After: 86400` — five minutes is high
// enough to honor a legitimate burst-quota cooldown but short enough to keep
// the dashboard responsive.
const RETRY_AFTER_MIN_MS = 1000;
const RETRY_AFTER_MAX_MS = 5 * 60 * 1000;
const RETRY_AFTER_DEFAULT_MS = 60 * 1000;

/**
 * Extract items + pagination metadata from a Vanta list response.
 *
 * Vanta exposes two response shapes across endpoints:
 *   - Nested  (`/v1/{collection}` — risk-scenarios, people, tests, etc.):
 *       { results: { data: [...], pageInfo: { hasNextPage, endCursor } } }
 *   - Flat    (`/v1/resources/{type}` — user_account):
 *       { resources: [...] }    // build-log.md confirms; no pageInfo seen
 *     and historically a separate flat form:
 *       { data: [...], pageInfo: {...} }
 *
 * The prior code read `items` from either nested.data or flat.data, but
 * `pageInfo` only from `results.pageInfo`. If a flat-shape endpoint
 * paginates with its own top-level pageInfo, every page after the first
 * would be silently dropped. This helper reads pageInfo symmetrically.
 *
 * Pure function — fetchAllPages calls it once per page.
 */
function extractPage(data) {
  if (data && typeof data === 'object') {
    // Nested shape — preferred when present.
    if (data.results !== undefined && data.results !== null) {
      return {
        items: data.results.data || [],
        pageInfo: data.results.pageInfo
      };
    }
    // Flat shape (with top-level data + pageInfo).
    if (Array.isArray(data.data)) {
      return {
        items: data.data,
        pageInfo: data.pageInfo
      };
    }
    // Flat shape (resources) — used by /v1/resources/{type}. No pageInfo
    // observed on these endpoints; included so callers that switch to
    // fetchAllPages get the items, with truncation detection downstream
    // catching the case where this endpoint ever starts paginating.
    if (Array.isArray(data.resources)) {
      return {
        items: data.resources,
        pageInfo: data.pageInfo
      };
    }
  }
  return { items: [], pageInfo: undefined };
}

/**
 * Parse a Retry-After header value into a wait duration in milliseconds.
 *
 * RFC 7231 allows two forms:
 *   - delta-seconds: `"120"`
 *   - HTTP-date:     `"Wed, 21 Oct 2026 07:28:00 GMT"`
 *
 * The previous implementation only handled delta-seconds via parseInt; an
 * HTTP-date produced `NaN`, then `setTimeout(fn, NaN)` fires immediately,
 * tight-looping the retry against an already-throttled endpoint.
 *
 * Missing / unparseable values fall back to RETRY_AFTER_DEFAULT_MS rather
 * than 0 so we always honor *some* cooldown. Parsed values are clamped to
 * [RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS].
 */
function parseRetryAfter(headerValue, now = Date.now()) {
  if (headerValue === undefined || headerValue === null || headerValue === '') {
    return RETRY_AFTER_DEFAULT_MS;
  }

  // Delta-seconds form. Number() is strict — "30s" → NaN, falls through.
  const asNumber = Number(headerValue);
  if (Number.isFinite(asNumber)) {
    return clampRetryAfter(asNumber * 1000);
  }

  // HTTP-date form. Past dates yield a non-positive delta, clamped to MIN.
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    return clampRetryAfter(asDate - now);
  }

  return RETRY_AFTER_DEFAULT_MS;
}

function clampRetryAfter(ms) {
  if (!Number.isFinite(ms)) return RETRY_AFTER_DEFAULT_MS;
  return Math.max(RETRY_AFTER_MIN_MS, Math.min(RETRY_AFTER_MAX_MS, ms));
}

// In-memory ring buffer of recent Vanta API calls — feeds the dashboard's
// Activity tab so customer engineers can see exactly what's going over the
// wire. Capped at 50; OAuth token requests are deliberately NOT logged here
// (they live in authManager and would leak credentials in their request body).
const REQUEST_LOG_MAX = 50;
const requestLog = [];
let requestIdCounter = 0;

function truncateBody(body) {
  if (body === null || body === undefined) return null;
  // Multipart upload bodies arrive as raw Buffers — don't attempt to
  // JSON.stringify them (would produce a giant integer-array dump). Surface
  // a meaningful summary instead so the activity log entry remains readable.
  if (Buffer.isBuffer(body)) {
    return {
      _multipart: true,
      _byteLength: body.length,
      preview: `(binary multipart body · ${body.length} bytes)`
    };
  }
  // Pretty-print object bodies before slicing — the activity-tab renderer
  // shows the preview as plain text, so capturing formatted (multi-line)
  // JSON makes the truncated preview readable instead of a wrapped wall of
  // compact JSON. Strings (HTML error pages, etc.) pass through untouched.
  const str = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  if (str.length <= 4000) {
    // Strings are immutable — pass through. Objects MUST be cloned: the
    // ring buffer holds these references, and a caller that reuses the
    // same `data` object across requests (or mutates it post-send) would
    // otherwise retroactively mutate this historical log entry.
    if (typeof body === 'string') return body;
    return structuredClone(body);
  }
  return {
    _truncated: true,
    _totalChars: str.length,
    preview: str.slice(0, 4000) + '…'
  };
}

function pushLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > REQUEST_LOG_MAX) requestLog.length = REQUEST_LOG_MAX;
}

function getRequestLog() {
  return requestLog.slice();
}

function clearRequestLog() {
  requestLog.length = 0;
}

/**
 * HTTP client bound to one auth manager and one rate-limit bucket.
 *
 * Two instances exist: `buildClient` against the Build Integrations app at
 * 20 req/min, `manageClient` against the Manage Vanta app at 50 req/min.
 * Vanta tracks rate limits per app, so the buckets are independent.
 */
class VantaHttpClient {
  constructor({ name, auth, rateLimitPerMinute }) {
    this.name = name;
    this.auth = auth;
    this.limiter = new Bottleneck({
      reservoir: rateLimitPerMinute,
      reservoirRefreshAmount: rateLimitPerMinute,
      reservoirRefreshInterval: 60 * 1000,
      maxConcurrent: 2
    });
  }

  async request(method, path, data = null, attempt = 1, options = {}) {
    const startTime = Date.now();
    const token = await this.auth.getToken();
    const url = `${BASE_URL}${path}`;
    const logEntry = {
      id: ++requestIdCounter,
      timestamp: new Date().toISOString(),
      app: this.name,
      method,
      path,
      attempt,
      status: null,
      durationMs: null,
      // Truncate the request body too — a large user_account snapshot can be
      // tens of KB, and storing 50 of them raw blows up the ring buffer's
      // memory footprint. Symmetric with how responseBody is handled below.
      requestBody: truncateBody(data),
      responseBody: null,
      error: null
    };

    try {
      // Only attach a body on writes — CloudFront's WAF rejects GETs that
      // carry a body (axios will serialize `data: null` as the literal "null"
      // otherwise, which trips a 403 with an HTML error page).
      // Timeout prevents the dashboard from hanging when Vanta is slow.
      // Default body timeout = 8s; multipart uploads can override via
      // options.timeout because file transfer dominates the wall clock.
      const config = {
        method,
        url,
        timeout: options.timeout || 8000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': options.contentType || 'application/json'
        }
      };
      if (data !== null && data !== undefined) {
        config.data = data;
      }
      // Multipart bodies can be larger than axios's default 10MB limit
      // (small evidence files are fine; SOC 2 attestation PDFs etc. push
      // close). Allow callers to lift the cap when known-large.
      if (options.maxBodyLength) {
        config.maxBodyLength = options.maxBodyLength;
        config.maxContentLength = options.maxBodyLength;
      }

      const response = await this.limiter.schedule(() => axios(config));

      logger.debug(`[${this.name}] ${method.toUpperCase()} ${path}`, { status: response.status });
      logEntry.status = response.status;
      logEntry.durationMs = Date.now() - startTime;
      logEntry.responseBody = truncateBody(response.data);
      pushLog(logEntry);
      return response.data;
    } catch (err) {
      const status = err.response?.status;

      // Token revoked — another caller for this app got a fresh token, per
      // Vanta's one-active-token-per-app rule. Invalidate cache and retry once.
      if (status === 401 && attempt === 1) {
        logger.warn(`[${this.name}] Token rejected (401). Invalidating cache and retrying.`, { path });
        this.auth.invalidateToken();
        return this.request(method, path, data, attempt + 1, options);
      }

      // Rate limited — honor Retry-After (delta-seconds or HTTP-date),
      // clamped to a sane range so a malformed/hostile value can't pin us.
      if (status === 429 && attempt <= MAX_RETRIES) {
        const retryAfter = parseRetryAfter(err.response.headers['retry-after']);
        logger.warn(`[${this.name}] Rate limited. Retrying in ${retryAfter}ms`, { attempt, path });
        await this._sleep(retryAfter);
        return this.request(method, path, data, attempt + 1, options);
      }

      // Transient server error — linear backoff
      if ((status === 503 || status === 504) && attempt <= MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        logger.warn(`[${this.name}] Server error ${status}. Retrying in ${delay}ms`, { attempt, path });
        await this._sleep(delay);
        return this.request(method, path, data, attempt + 1, options);
      }

      // Surface the full Vanta error body — schema validation errors put detail
      // on `data.error` (a string), not `data.message`.
      const body = err.response?.data;
      logger.error(`[${this.name}] API request failed: ${method.toUpperCase()} ${path}`, {
        status,
        body: body !== undefined ? truncateBody(body) : null,
        attempt
      });
      logEntry.status = status || 0;
      logEntry.durationMs = Date.now() - startTime;
      logEntry.responseBody = body !== undefined ? truncateBody(body) : null;
      logEntry.error = err.message;
      pushLog(logEntry);
      throw err;
    }
  }

  async fetchAllPages(path, queryParams = {}) {
    const results = [];
    let cursor = null;
    let page = 1;

    do {
      if (page > MAX_PAGES) {
        throw new Error(`[${this.name}] Pagination exceeded ${MAX_PAGES} pages for ${path}`);
      }

      const params = new URLSearchParams({ ...queryParams, pageSize: PAGE_SIZE });
      if (cursor) params.set('pageCursor', cursor);

      const fullPath = `${path}?${params.toString()}`;
      const data = await this.request('GET', fullPath);

      const { items, pageInfo } = extractPage(data);
      results.push(...items);

      // Silent-truncation guard: a response that returns exactly PAGE_SIZE
      // items but no pageInfo is suspicious — either the endpoint shape
      // changed, or it paginates with metadata in a form we don't recognize.
      // Either way, terminating quietly would lose every subsequent record.
      if (!pageInfo && items.length === PAGE_SIZE) {
        throw new Error(
          `[${this.name}] Got a full page (${PAGE_SIZE}) from ${path} but no pageInfo in the response. ` +
          `Possible silent truncation — endpoint may use an unrecognized pagination shape. ` +
          `Inspect the raw response and extend extractPage() if needed.`
        );
      }

      cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;

      logger.debug(`[${this.name}] Fetched page ${page} from ${path}`, { count: items.length, hasMore: !!cursor });
      page++;
    } while (cursor);

    logger.info(`[${this.name}] Fetched all pages from ${path}`, { totalRecords: results.length });
    return results;
  }

  get(path)         { return this.request('GET', path, null); }
  post(path, data)  { return this.request('POST', path, data); }
  patch(path, data) { return this.request('PATCH', path, data); }
  put(path, data)   { return this.request('PUT', path, data); }
  delete(path)      { return this.request('DELETE', path); }

  /**
   * POST a multipart/form-data body. Used for evidence-file uploads to
   * `/v1/documents/{slug}/uploads` per the Phase 0 probe finding. Each
   * `parts` entry is either:
   *   - `{ name, value }`               — plain form field (string value)
   *   - `{ name, filename, contentType?, value }` — file part (value: Buffer)
   *
   * Routes through this.request() so the same auth/limiter/retry/activity-log
   * machinery applies. The activity-log preview shows a multipart summary
   * (byte count) rather than the binary body.
   *
   * Returns the parsed JSON response (`{ id, fileName, url, ... }` per the
   * Phase 0 documented response shape).
   */
  async postMultipart(path, parts) {
    const boundary = '----LlamaLync' + Math.random().toString(36).slice(2, 14);
    const body = buildMultipartBody(boundary, parts);
    return this.request('POST', path, body, 1, {
      contentType: `multipart/form-data; boundary=${boundary}`,
      maxBodyLength: 50 * 1024 * 1024,  // 50MB ceiling — Vanta will reject larger anyway
      timeout: 30000                    // multipart transfer can outlast the JSON 8s default
    });
  }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

/**
 * Build a multipart/form-data body as a Buffer. Avoids the form-data npm
 * package — the codebase has zero direct multipart consumers besides this
 * one client method, so a small hand-rolled builder is cheaper than a
 * dependency. Mirrors the shape probeDocumentUpload.js uses; both can be
 * collapsed to a shared helper if a third consumer appears.
 */
function buildMultipartBody(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
        `Content-Type: ${p.contentType || 'application/octet-stream'}\r\n\r\n`
      ));
      chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"\r\n\r\n` +
        `${p.value}`
      ));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const buildClient = new VantaHttpClient({
  name: 'build',
  auth: buildAuth,
  rateLimitPerMinute: 20
});

const manageClient = new VantaHttpClient({
  name: 'manage',
  auth: manageAuth,
  rateLimitPerMinute: 50
});

module.exports = {
  VantaHttpClient,
  buildClient,
  manageClient,
  getRequestLog,
  clearRequestLog,
  parseRetryAfter,
  RETRY_AFTER_MIN_MS,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_DEFAULT_MS,
  extractPage,
  PAGE_SIZE,
  truncateBody
};
