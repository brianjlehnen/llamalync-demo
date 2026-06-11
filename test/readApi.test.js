const { describe, test } = require('node:test');
const assert = require('node:assert');

const { buildSLAQueryParams } = require('../src/sync/readApi');

const NOW = new Date('2026-05-18T12:00:00Z');

describe('buildSLAQueryParams — both bounds present (EC2 fix)', () => {
  test('includes status: OPEN', () => {
    const params = buildSLAQueryParams(7, NOW);
    assert.strictEqual(params.status, 'OPEN');
  });

  test('remediationDeadlineAfter equals now (excludes already-breached vulns)', () => {
    // The original bug: no After bound meant the result mixed
    // already-breached SLAs with approaching-but-not-yet ones.
    const params = buildSLAQueryParams(7, NOW);
    assert.strictEqual(params.remediationDeadlineAfter, NOW.toISOString());
  });

  test('remediationDeadlineBefore equals now + N days', () => {
    const params = buildSLAQueryParams(7, NOW);
    const expected = new Date(NOW);
    expected.setDate(expected.getDate() + 7);
    assert.strictEqual(params.remediationDeadlineBefore, expected.toISOString());
  });

  test('both bounds use the same now instant (no drift)', () => {
    // If the implementation called `new Date()` twice independently, an
    // unlucky ms-boundary execution could produce slightly different
    // values. Same `now` argument guarantees they're consistent.
    const params = buildSLAQueryParams(0, NOW);
    assert.strictEqual(params.remediationDeadlineAfter, NOW.toISOString());
    assert.strictEqual(params.remediationDeadlineBefore, NOW.toISOString());
  });

  test('daysAhead = 0 means After == Before (no window)', () => {
    const params = buildSLAQueryParams(0, NOW);
    assert.strictEqual(params.remediationDeadlineAfter, params.remediationDeadlineBefore);
  });

  test('daysAhead = 30 produces a 30-day window', () => {
    const params = buildSLAQueryParams(30, NOW);
    const expected = new Date(NOW);
    expected.setDate(expected.getDate() + 30);
    assert.strictEqual(params.remediationDeadlineBefore, expected.toISOString());
  });
});

describe('buildSLAQueryParams — defaults', () => {
  test('default `now` is current time (no explicit argument needed)', () => {
    const before = Date.now();
    const params = buildSLAQueryParams(7);
    const after = Date.now();
    const afterTs = Date.parse(params.remediationDeadlineAfter);
    assert.ok(afterTs >= before && afterTs <= after);
  });
});
