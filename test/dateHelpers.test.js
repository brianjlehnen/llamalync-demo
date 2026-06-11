const { describe, test } = require('node:test');
const assert = require('node:assert');

const { isBeforeOrMissing } = require('../src/utils/dateHelpers');

// Fixed reference instant so tests don't drift with wall-clock time.
const NOW = new Date('2026-05-18T12:00:00Z');
const CUTOFF_30D = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

describe('isBeforeOrMissing — happy path', () => {
  test('date strictly before cutoff returns true', () => {
    const old = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(isBeforeOrMissing(old, CUTOFF_30D), true);
  });

  test('date at or after cutoff returns false', () => {
    const recent = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();
    assert.strictEqual(isBeforeOrMissing(recent, CUTOFF_30D), false);
  });

  test('date exactly at cutoff returns false (boundary)', () => {
    // `<` is strict, so a date equal to the cutoff is NOT before it.
    assert.strictEqual(isBeforeOrMissing(CUTOFF_30D.toISOString(), CUTOFF_30D), false);
  });

  test('Date object input is accepted', () => {
    const old = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);
    assert.strictEqual(isBeforeOrMissing(old, CUTOFF_30D), true);
  });
});

describe('isBeforeOrMissing — missing / invalid dates are treated as stale (the original bug)', () => {
  // Original behavior: `new Date(undefined) < cutoff` is NaN comparison →
  // false. So records missing the date field would NEVER flag as stale.
  // That's the opposite of what every reasonable staleness check wants.

  test('undefined returns true', () => {
    assert.strictEqual(isBeforeOrMissing(undefined, CUTOFF_30D), true);
  });

  test('null returns true', () => {
    assert.strictEqual(isBeforeOrMissing(null, CUTOFF_30D), true);
  });

  test('empty string returns true', () => {
    assert.strictEqual(isBeforeOrMissing('', CUTOFF_30D), true);
  });

  test('garbage string returns true (unparseable date)', () => {
    assert.strictEqual(isBeforeOrMissing('not-a-date', CUTOFF_30D), true);
  });

  test('NaN-producing date string returns true', () => {
    assert.strictEqual(isBeforeOrMissing('2026-13-99', CUTOFF_30D), true);
  });
});

describe('isBeforeOrMissing — date-only strings (YYYY-MM-DD)', () => {
  test('YYYY-MM-DD strings parse correctly', () => {
    // Mock-data uses YYYY-MM-DD for startDate / lastSeen / lastReviewedAt.
    assert.strictEqual(isBeforeOrMissing('2024-01-01', CUTOFF_30D), true);
    assert.strictEqual(isBeforeOrMissing('2026-05-15', CUTOFF_30D), false);
  });
});
