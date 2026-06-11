const { describe, test } = require('node:test');
const assert = require('node:assert');

const { parseTokenResponse } = require('../src/auth/authManager');

// Fixed reference instant so expiresAt math is deterministic.
const NOW = Date.parse('2026-05-15T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW / 1000);

describe('parseTokenResponse — happy path', () => {
  test('valid response returns token + computed expiresAt + expiresIn', () => {
    const result = parseTokenResponse(
      { access_token: 'abc123', expires_in: 3600 },
      NOW
    );
    assert.strictEqual(result.token, 'abc123');
    assert.strictEqual(result.expiresAt, NOW_SECONDS + 3600);
    assert.strictEqual(result.expiresIn, 3600);
  });

  test('expires_in as numeric string is coerced and accepted', () => {
    const result = parseTokenResponse(
      { access_token: 'abc', expires_in: '3600' },
      NOW
    );
    assert.strictEqual(result.expiresIn, 3600);
    assert.strictEqual(result.expiresAt, NOW_SECONDS + 3600);
  });

  test('extra fields in response are ignored', () => {
    const result = parseTokenResponse(
      { access_token: 'abc', expires_in: 60, token_type: 'Bearer', scope: 'a b c' },
      NOW
    );
    assert.strictEqual(result.token, 'abc');
    assert.strictEqual(result.expiresIn, 60);
  });
});

describe('parseTokenResponse — missing or malformed access_token', () => {
  test('missing access_token throws specific error', () => {
    assert.throws(
      () => parseTokenResponse({ expires_in: 3600 }, NOW),
      /missing access_token/
    );
  });

  test('empty access_token throws', () => {
    assert.throws(
      () => parseTokenResponse({ access_token: '', expires_in: 3600 }, NOW),
      /missing access_token/
    );
  });

  test('non-string access_token throws (number)', () => {
    assert.throws(
      () => parseTokenResponse({ access_token: 12345, expires_in: 3600 }, NOW),
      /missing access_token/
    );
  });

  test('non-string access_token throws (null)', () => {
    assert.throws(
      () => parseTokenResponse({ access_token: null, expires_in: 3600 }, NOW),
      /missing access_token/
    );
  });
});

describe('parseTokenResponse — missing or malformed expires_in (the original bug)', () => {
  test('missing expires_in throws — does NOT silently produce NaN expiry', () => {
    assert.throws(
      () => parseTokenResponse({ access_token: 'abc' }, NOW),
      /missing or invalid expires_in/
    );
  });

  test('expires_in: 0 throws (zero-TTL token is useless)', () => {
    assert.throws(
      () => parseTokenResponse({ access_token: 'abc', expires_in: 0 }, NOW),
      /missing or invalid expires_in/
    );
  });

  test('negative expires_in throws', () => {
    assert.throws(
      () => parseTokenResponse({ access_token: 'abc', expires_in: -1 }, NOW),
      /missing or invalid expires_in/
    );
  });

  test('non-numeric expires_in throws', () => {
    assert.throws(
      () => parseTokenResponse({ access_token: 'abc', expires_in: 'never' }, NOW),
      /missing or invalid expires_in/
    );
  });

  test('null expires_in throws', () => {
    assert.throws(
      () => parseTokenResponse({ access_token: 'abc', expires_in: null }, NOW),
      /missing or invalid expires_in/
    );
  });
});

describe('parseTokenResponse — missing or malformed response object', () => {
  test('null data throws', () => {
    assert.throws(() => parseTokenResponse(null, NOW), /missing access_token/);
  });

  test('undefined data throws', () => {
    assert.throws(() => parseTokenResponse(undefined, NOW), /missing access_token/);
  });

  test('empty object throws', () => {
    assert.throws(() => parseTokenResponse({}, NOW), /missing access_token/);
  });
});

describe('parseTokenResponse — expiresAt math', () => {
  test('expiresAt is now + expires_in, in seconds', () => {
    const result = parseTokenResponse(
      { access_token: 'abc', expires_in: 7200 },
      NOW
    );
    assert.strictEqual(result.expiresAt, NOW_SECONDS + 7200);
  });

  test('fractional now is floored before adding expires_in', () => {
    // Date.now() returns ms; the prior code used Math.floor(Date.now() / 1000).
    // 12:00:00.999Z → 12:00:00 seconds, not 12:00:01.
    const fractional = NOW + 999;
    const result = parseTokenResponse(
      { access_token: 'abc', expires_in: 60 },
      fractional
    );
    assert.strictEqual(result.expiresAt, NOW_SECONDS + 60);
  });
});
