const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  parseRetryAfter,
  RETRY_AFTER_MIN_MS,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_DEFAULT_MS,
  extractPage,
  PAGE_SIZE,
  VantaHttpClient,
  truncateBody
} = require('../src/http/vantaClient');

function makeClientWithStubbedRequest(responses) {
  const calls = [];
  const client = new VantaHttpClient({
    name: 'test',
    auth: { getToken: async () => 'tok' },
    rateLimitPerMinute: 100
  });
  client.request = async (method, path) => {
    calls.push({ method, path });
    if (responses.length === 0) throw new Error('Unexpected extra request');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { client, calls };
}

// Fixed reference instant so HTTP-date tests are deterministic.
const NOW = Date.parse('2026-05-15T12:00:00Z');

describe('parseRetryAfter — delta-seconds form (RFC 7231)', () => {
  test('"30" returns 30s in ms', () => {
    assert.strictEqual(parseRetryAfter('30', NOW), 30_000);
  });

  test('"120" returns 120s in ms', () => {
    assert.strictEqual(parseRetryAfter('120', NOW), 120_000);
  });

  test('numeric value (not string) works', () => {
    assert.strictEqual(parseRetryAfter(30, NOW), 30_000);
  });

  test('whitespace around digits is tolerated', () => {
    assert.strictEqual(parseRetryAfter(' 30 ', NOW), 30_000);
  });
});

describe('parseRetryAfter — HTTP-date form (the original bug)', () => {
  test('future HTTP-date returns delta from now (no NaN tight loop)', () => {
    const future = new Date(NOW + 90_000).toUTCString();
    assert.strictEqual(parseRetryAfter(future, NOW), 90_000);
  });

  test('past HTTP-date is clamped to MIN (cannot fire immediately)', () => {
    const past = new Date(NOW - 60_000).toUTCString();
    assert.strictEqual(parseRetryAfter(past, NOW), RETRY_AFTER_MIN_MS);
  });

  test('HTTP-date exactly at now clamps to MIN', () => {
    const exactly = new Date(NOW).toUTCString();
    assert.strictEqual(parseRetryAfter(exactly, NOW), RETRY_AFTER_MIN_MS);
  });

  test('ISO 8601 date also parses (Date.parse is permissive)', () => {
    const future = new Date(NOW + 45_000).toISOString();
    assert.strictEqual(parseRetryAfter(future, NOW), 45_000);
  });
});

describe('parseRetryAfter — missing / malformed values', () => {
  test('undefined falls back to default', () => {
    assert.strictEqual(parseRetryAfter(undefined, NOW), RETRY_AFTER_DEFAULT_MS);
  });

  test('null falls back to default', () => {
    assert.strictEqual(parseRetryAfter(null, NOW), RETRY_AFTER_DEFAULT_MS);
  });

  test('empty string falls back to default', () => {
    assert.strictEqual(parseRetryAfter('', NOW), RETRY_AFTER_DEFAULT_MS);
  });

  test('garbage string falls back to default', () => {
    assert.strictEqual(parseRetryAfter('not-a-date-or-number', NOW), RETRY_AFTER_DEFAULT_MS);
  });

  test('"30s" with trailing unit is rejected and falls back to default', () => {
    // Number("30s") = NaN; Date.parse("30s") = NaN. Spec-invalid value.
    assert.strictEqual(parseRetryAfter('30s', NOW), RETRY_AFTER_DEFAULT_MS);
  });
});

describe('parseRetryAfter — clamping', () => {
  test('"0" clamps up to MIN (prevents tight loop on Retry-After: 0)', () => {
    assert.strictEqual(parseRetryAfter('0', NOW), RETRY_AFTER_MIN_MS);
  });

  test('negative value clamps up to MIN', () => {
    assert.strictEqual(parseRetryAfter('-10', NOW), RETRY_AFTER_MIN_MS);
  });

  test('"86400" (one day) clamps down to MAX', () => {
    assert.strictEqual(parseRetryAfter('86400', NOW), RETRY_AFTER_MAX_MS);
  });

  test('far-future HTTP-date clamps down to MAX', () => {
    const farFuture = new Date(NOW + 24 * 60 * 60 * 1000).toUTCString();
    assert.strictEqual(parseRetryAfter(farFuture, NOW), RETRY_AFTER_MAX_MS);
  });

  test('value exactly at MAX passes through', () => {
    const exactMaxSeconds = String(RETRY_AFTER_MAX_MS / 1000);
    assert.strictEqual(parseRetryAfter(exactMaxSeconds, NOW), RETRY_AFTER_MAX_MS);
  });

  test('value exactly at MIN passes through', () => {
    assert.strictEqual(parseRetryAfter('1', NOW), RETRY_AFTER_MIN_MS);
  });
});

describe('parseRetryAfter — bounds sanity', () => {
  test('MIN < DEFAULT < MAX', () => {
    assert.ok(RETRY_AFTER_MIN_MS < RETRY_AFTER_DEFAULT_MS);
    assert.ok(RETRY_AFTER_DEFAULT_MS < RETRY_AFTER_MAX_MS);
  });
});

describe('extractPage — nested shape (data.results.{data,pageInfo})', () => {
  test('extracts items and pageInfo together', () => {
    const data = {
      results: {
        data: [{ id: 1 }, { id: 2 }],
        pageInfo: { hasNextPage: true, endCursor: 'c1' }
      }
    };
    assert.deepStrictEqual(extractPage(data), {
      items: [{ id: 1 }, { id: 2 }],
      pageInfo: { hasNextPage: true, endCursor: 'c1' }
    });
  });

  test('missing pageInfo returns items + undefined pageInfo', () => {
    const data = { results: { data: [{ id: 1 }] } };
    const result = extractPage(data);
    assert.deepStrictEqual(result.items, [{ id: 1 }]);
    assert.strictEqual(result.pageInfo, undefined);
  });

  test('missing data array yields empty items', () => {
    const data = { results: { pageInfo: { hasNextPage: false } } };
    const result = extractPage(data);
    assert.deepStrictEqual(result.items, []);
    assert.deepStrictEqual(result.pageInfo, { hasNextPage: false });
  });
});

describe('extractPage — flat shape (data.{data,pageInfo}) — the original bug', () => {
  test('reads pageInfo symmetrically from top level', () => {
    // The prior code read items from `data.data` but only pageInfo from
    // `data.results.pageInfo`, so a flat-shape paginated response silently
    // truncated after page 1. This is the regression test for that.
    const data = {
      data: [{ id: 1 }, { id: 2 }],
      pageInfo: { hasNextPage: true, endCursor: 'flat-cursor' }
    };
    assert.deepStrictEqual(extractPage(data), {
      items: [{ id: 1 }, { id: 2 }],
      pageInfo: { hasNextPage: true, endCursor: 'flat-cursor' }
    });
  });

  test('flat shape without pageInfo returns items + undefined pageInfo', () => {
    const data = { data: [{ id: 1 }] };
    const result = extractPage(data);
    assert.deepStrictEqual(result.items, [{ id: 1 }]);
    assert.strictEqual(result.pageInfo, undefined);
  });
});

describe('extractPage — resources shape (/v1/resources/{type})', () => {
  test('reads resources array (used by /v1/resources/user_account)', () => {
    const data = { resources: [{ uniqueId: 'u1' }, { uniqueId: 'u2' }] };
    assert.deepStrictEqual(extractPage(data), {
      items: [{ uniqueId: 'u1' }, { uniqueId: 'u2' }],
      pageInfo: undefined
    });
  });
});

describe('extractPage — degenerate inputs', () => {
  test('null returns empty page', () => {
    assert.deepStrictEqual(extractPage(null), { items: [], pageInfo: undefined });
  });

  test('undefined returns empty page', () => {
    assert.deepStrictEqual(extractPage(undefined), { items: [], pageInfo: undefined });
  });

  test('empty object returns empty page', () => {
    assert.deepStrictEqual(extractPage({}), { items: [], pageInfo: undefined });
  });

  test('nested shape wins when both shapes are present', () => {
    // Defensive: if a future endpoint returns both, prefer the explicit nested
    // shape. Avoids ambiguity about which pageInfo authoritative.
    const data = {
      results: { data: [{ id: 'nested' }], pageInfo: { hasNextPage: false } },
      data: [{ id: 'flat' }]
    };
    assert.deepStrictEqual(extractPage(data).items, [{ id: 'nested' }]);
  });
});

describe('fetchAllPages — integration', () => {
  test('single-page nested response with hasNextPage=false terminates after one call', async () => {
    const { client, calls } = makeClientWithStubbedRequest([
      { results: { data: [{ id: 1 }, { id: 2 }], pageInfo: { hasNextPage: false } } }
    ]);
    const result = await client.fetchAllPages('/v1/risk-scenarios');
    assert.deepStrictEqual(result, [{ id: 1 }, { id: 2 }]);
    assert.strictEqual(calls.length, 1);
  });

  test('multi-page nested response walks the cursor and concatenates', async () => {
    const { client, calls } = makeClientWithStubbedRequest([
      { results: { data: [{ id: 1 }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } },
      { results: { data: [{ id: 2 }], pageInfo: { hasNextPage: true, endCursor: 'c2' } } },
      { results: { data: [{ id: 3 }], pageInfo: { hasNextPage: false } } }
    ]);
    const result = await client.fetchAllPages('/v1/people');
    assert.deepStrictEqual(result, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.strictEqual(calls.length, 3);
    assert.ok(calls[1].path.includes('pageCursor=c1'));
    assert.ok(calls[2].path.includes('pageCursor=c2'));
  });

  test('partial page with no pageInfo terminates cleanly (single-shot endpoint)', async () => {
    // /v1/resources/user_account returns { resources: [...] } with no
    // pageInfo when the result fits in a single page. Must not throw.
    const items = Array.from({ length: 50 }, (_, i) => ({ uniqueId: `u${i}` }));
    const { client } = makeClientWithStubbedRequest([{ resources: items }]);
    const result = await client.fetchAllPages('/v1/resources/user_account');
    assert.strictEqual(result.length, 50);
  });

  test('empty response terminates cleanly', async () => {
    const { client } = makeClientWithStubbedRequest([
      { results: { data: [], pageInfo: { hasNextPage: false } } }
    ]);
    const result = await client.fetchAllPages('/v1/anything');
    assert.deepStrictEqual(result, []);
  });

  test('full page (PAGE_SIZE items) with NO pageInfo throws silent-truncation error', async () => {
    // This is the load-bearing test for the new guard: an endpoint that
    // returns exactly a full page worth but no pagination metadata is
    // either (a) using a shape we don't recognize, or (b) silently
    // truncating. Either way we refuse to return a partial result.
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i }));
    const { client } = makeClientWithStubbedRequest([{ resources: fullPage }]);
    await assert.rejects(
      client.fetchAllPages('/v1/resources/user_account'),
      /Possible silent truncation/
    );
  });

  test('flat shape with pageInfo walks pages symmetrically (the original-bug fix)', async () => {
    const { client, calls } = makeClientWithStubbedRequest([
      { data: [{ id: 1 }], pageInfo: { hasNextPage: true, endCursor: 'flat-1' } },
      { data: [{ id: 2 }], pageInfo: { hasNextPage: false } }
    ]);
    const result = await client.fetchAllPages('/v1/hypothetical-flat-endpoint');
    assert.deepStrictEqual(result, [{ id: 1 }, { id: 2 }]);
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1].path.includes('pageCursor=flat-1'));
  });

  test('query params from caller are preserved across pages', async () => {
    const { client, calls } = makeClientWithStubbedRequest([
      { results: { data: [], pageInfo: { hasNextPage: false } } }
    ]);
    await client.fetchAllPages('/v1/vulnerabilities', { status: 'OPEN' });
    assert.ok(calls[0].path.includes('status=OPEN'));
    assert.ok(calls[0].path.includes(`pageSize=${PAGE_SIZE}`));
  });
});

describe('truncateBody — clone semantics (P3 fix)', () => {
  test('small object body is cloned, not returned by reference', () => {
    // The ring buffer stores these for the dashboard activity tab. If we
    // return the caller's live reference and the caller reuses the same
    // object for a later request (or mutates it post-send), the historical
    // log entry would mutate too. Clone defends against that.
    const body = { a: 1, b: { c: 2 } };
    const truncated = truncateBody(body);
    assert.notStrictEqual(truncated, body, 'must not return the same reference');
    assert.notStrictEqual(truncated.b, body.b, 'nested objects must also be cloned');
    assert.deepStrictEqual(truncated, body, 'but the content matches');
  });

  test('mutating the original after truncate does not affect the log entry', () => {
    const body = { a: 1 };
    const truncated = truncateBody(body);
    body.a = 999;
    body.b = 'added later';
    assert.strictEqual(truncated.a, 1, 'log entry preserves the value at log time');
    assert.strictEqual(truncated.b, undefined, 'added fields do not leak in');
  });

  test('mutating a nested object after truncate does not affect the log entry', () => {
    const body = { resources: [{ uniqueId: 'u1' }] };
    const truncated = truncateBody(body);
    body.resources.push({ uniqueId: 'late-add' });
    body.resources[0].uniqueId = 'mutated';
    assert.strictEqual(truncated.resources.length, 1);
    assert.strictEqual(truncated.resources[0].uniqueId, 'u1');
  });
});

describe('truncateBody — other paths unchanged', () => {
  test('null returns null', () => {
    assert.strictEqual(truncateBody(null), null);
  });

  test('undefined returns null', () => {
    assert.strictEqual(truncateBody(undefined), null);
  });

  test('Buffer returns multipart summary, not the bytes', () => {
    const buf = Buffer.from('--boundary\r\nContent-Disposition: form-data\r\n\r\nhello\r\n--boundary--\r\n');
    const result = truncateBody(buf);
    assert.strictEqual(result._multipart, true);
    assert.strictEqual(result._byteLength, buf.length);
    assert.ok(result.preview.includes('binary multipart body'));
  });

  test('string body passes through (immutable, no clone needed)', () => {
    const s = 'plain text response';
    // Strings can't be mutated so we can return the same reference safely.
    // (Identity check would be brittle across JS engines; just check value.)
    assert.strictEqual(truncateBody(s), s);
  });

  test('object body over 4000 chars returns truncated preview, not the body', () => {
    const huge = { items: Array.from({ length: 500 }, (_, i) => ({ id: `item-${i}`, value: 'x'.repeat(20) })) };
    const truncated = truncateBody(huge);
    assert.strictEqual(truncated._truncated, true);
    assert.ok(truncated._totalChars > 4000);
    assert.ok(truncated.preview.endsWith('…'));
    assert.strictEqual(truncated.preview.length, 4001); // 4000 chars + the ellipsis
  });

  test('string body over 4000 chars returns truncated preview', () => {
    const long = 'a'.repeat(5000);
    const truncated = truncateBody(long);
    assert.strictEqual(truncated._truncated, true);
    assert.strictEqual(truncated._totalChars, 5000);
  });
});
