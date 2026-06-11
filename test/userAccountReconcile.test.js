const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { computeDrift, getDriftCheck, _resetCache } = require('../src/reconcile/userAccountReconcile');

function makeEmp(id, overrides = {}) {
  return {
    id,
    email: `${id}@peoplex.example.com`,
    firstName: 'Test',
    lastName: id,
    startDate: '2024-01-01',
    status: 'active',
    isServiceAccount: false,
    ...overrides
  };
}

// Mirrors the shape Vanta's GET /v1/resources/user_account returns: full
// resource object including fields we deliberately exclude from the drift
// card (MFA, timestamps, URLs). Tests verify compact() strips these.
function makeVantaRecord(uniqueId, overrides = {}) {
  return {
    uniqueId,
    email: `${uniqueId}@peoplex.example.com`,
    displayName: `Test ${uniqueId}`,
    fullName: `Test ${uniqueId}`,
    accountName: uniqueId,
    externalUrl: `https://peoplex.example.com/hr/employees/${uniqueId}`,
    permissionLevel: 'BASE',
    mfaEnabled: false,
    mfaMethods: [],
    status: 'ACTIVE',
    authMethod: 'PASSWORD',
    createdTimestamp: '2024-01-01T00:00:00.000Z',
    lastLoginTimestamp: '2025-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('computeDrift', () => {
  test('perfect sync — no drift', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [makeEmp('1'), makeEmp('2')] }),
      fetchVantaResources: async () => [makeVantaRecord('1'), makeVantaRecord('2')]
    });
    assert.strictEqual(result.drift.missing.length, 0);
    assert.strictEqual(result.drift.extra.length, 0);
    assert.strictEqual(result.drift.changed.length, 0);
    assert.strictEqual(result.sourceActiveCount, 2);
    assert.strictEqual(result.vantaActiveCount, 2);
  });

  test('missing in Vanta — present in source, absent in Vanta', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [makeEmp('1'), makeEmp('2')] }),
      fetchVantaResources: async () => [makeVantaRecord('1')]
    });
    assert.strictEqual(result.drift.missing.length, 1);
    assert.strictEqual(result.drift.missing[0].uniqueId, '2');
    assert.strictEqual(result.drift.extra.length, 0);
  });

  test('extra in Vanta — absent in source', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [makeEmp('1')] }),
      fetchVantaResources: async () => [makeVantaRecord('1'), makeVantaRecord('2')]
    });
    assert.strictEqual(result.drift.extra.length, 1);
    assert.strictEqual(result.drift.extra[0].uniqueId, '2');
    assert.strictEqual(result.drift.missing.length, 0);
  });

  test('changed — email differs', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [makeEmp('1', { email: 'new@peoplex.example.com' })] }),
      fetchVantaResources: async () => [makeVantaRecord('1', { email: 'old@peoplex.example.com' })]
    });
    assert.strictEqual(result.drift.changed.length, 1);
    const c = result.drift.changed[0];
    assert.strictEqual(c.uniqueId, '1');
    assert.deepStrictEqual(c.diffs, [
      { field: 'email', source: 'new@peoplex.example.com', vanta: 'old@peoplex.example.com' }
    ]);
  });

  test('changed — displayName differs', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [makeEmp('1', { firstName: 'Updated' })] }),
      fetchVantaResources: async () => [makeVantaRecord('1', { displayName: 'Test 1' })]
    });
    assert.strictEqual(result.drift.changed.length, 1);
    assert.deepStrictEqual(result.drift.changed[0].diffs, [
      { field: 'displayName', source: 'Updated 1', vanta: 'Test 1' }
    ]);
  });

  test('changed — both fields differ in one record', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [makeEmp('1', { firstName: 'New', email: 'a@x.com' })] }),
      fetchVantaResources: async () => [makeVantaRecord('1', { displayName: 'Old 1', email: 'b@x.com' })]
    });
    assert.strictEqual(result.drift.changed.length, 1);
    assert.strictEqual(result.drift.changed[0].diffs.length, 2);
  });

  test('empty source + non-empty Vanta — all show as extra', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [] }),
      fetchVantaResources: async () => [makeVantaRecord('1'), makeVantaRecord('2')]
    });
    assert.strictEqual(result.drift.extra.length, 2);
    assert.strictEqual(result.drift.missing.length, 0);
    assert.strictEqual(result.sourceActiveCount, 0);
    assert.strictEqual(result.vantaActiveCount, 2);
  });

  test('empty Vanta + non-empty source — all show as missing', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [makeEmp('1'), makeEmp('2')] }),
      fetchVantaResources: async () => []
    });
    assert.strictEqual(result.drift.missing.length, 2);
    assert.strictEqual(result.drift.extra.length, 0);
  });

  test('compact records carry only uniqueId/email/displayName', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [] }),
      fetchVantaResources: async () => [makeVantaRecord('1')]
    });
    const extraRecord = result.drift.extra[0];
    assert.deepStrictEqual(
      Object.keys(extraRecord).sort(),
      ['displayName', 'email', 'uniqueId']
    );
  });

  test('changed records expose diffs but no MFA/URL/timestamps', async () => {
    const result = await computeDrift({
      loadEmployees: () => ({ data: [makeEmp('1', { email: 'new@x.com' })] }),
      fetchVantaResources: async () => [makeVantaRecord('1', { email: 'old@x.com' })]
    });
    const c = result.drift.changed[0];
    assert.deepStrictEqual(
      Object.keys(c).sort(),
      ['diffs', 'displayName', 'email', 'uniqueId']
    );
    // diff entries also stay compact
    assert.deepStrictEqual(
      Object.keys(c.diffs[0]).sort(),
      ['field', 'source', 'vanta']
    );
  });

  test('service accounts and terminated source records are filtered out', async () => {
    const employees = [
      makeEmp('1'),
      makeEmp('2', { isServiceAccount: true }),
      makeEmp('3', { status: 'terminated' })
    ];
    const result = await computeDrift({
      loadEmployees: () => ({ data: employees }),
      fetchVantaResources: async () => [makeVantaRecord('1')]
    });
    assert.strictEqual(result.sourceActiveCount, 1);
    assert.strictEqual(result.drift.missing.length, 0);
    assert.strictEqual(result.drift.extra.length, 0);
  });
});

describe('getDriftCheck — cache + error isolation', () => {
  beforeEach(() => _resetCache());

  test('returns { error } on failure with no prior good payload', async () => {
    const result = await getDriftCheck({
      loadEmployees: () => ({ data: [makeEmp('1')] }),
      fetchVantaResources: async () => { throw new Error('boom'); }
    });
    assert.strictEqual(result.error, 'boom');
    assert.strictEqual(result.stale, undefined);
  });

  test('serves cached fresh within TTL — does not re-fetch', async () => {
    let now = 1000;
    let fetchCount = 0;
    const employees = [makeEmp('1')];
    await getDriftCheck({
      loadEmployees: () => ({ data: employees }),
      fetchVantaResources: async () => { fetchCount++; return [makeVantaRecord('1')]; },
      now: () => now
    });
    assert.strictEqual(fetchCount, 1);

    now = 1000 + 30_000; // within 60s TTL
    await getDriftCheck({
      loadEmployees: () => ({ data: employees }),
      fetchVantaResources: async () => { fetchCount++; return []; },
      now: () => now
    });
    assert.strictEqual(fetchCount, 1, 'should hit cache, not re-fetch');
  });

  test('serves stale on error if prior good payload exists (even past TTL)', async () => {
    let now = 1000;
    const employees = [makeEmp('1')];

    // First call succeeds
    const fresh = await getDriftCheck({
      loadEmployees: () => ({ data: employees }),
      fetchVantaResources: async () => [makeVantaRecord('1')],
      now: () => now
    });
    assert.strictEqual(fresh.stale, undefined);
    assert.strictEqual(fresh.sourceActiveCount, 1);

    // Advance well past TTL
    now = 1000 + 5 * 60_000;

    // Second call fails — should serve stale, not { error }-only
    const stale = await getDriftCheck({
      loadEmployees: () => ({ data: employees }),
      fetchVantaResources: async () => { throw new Error('vanta unreachable'); },
      now: () => now
    });
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.error, 'vanta unreachable');
    assert.strictEqual(stale.sourceActiveCount, 1, 'cached payload preserved');
  });

  test('source mutations within TTL show drift without re-fetching Vanta', async () => {
    // Regression: an earlier implementation cached the full drift result, so
    // a Hire/Offboard within the TTL window was invisible until cache expired.
    let now = 1000;
    let fetchCount = 0;
    let employees = [makeEmp('1')];

    const first = await getDriftCheck({
      loadEmployees: () => ({ data: employees }),
      fetchVantaResources: async () => { fetchCount++; return [makeVantaRecord('1')]; },
      now: () => now
    });
    assert.strictEqual(first.drift.missing.length, 0, 'first check should be clean');
    assert.strictEqual(fetchCount, 1);

    // Add a new hire 1s later — well within the 60s TTL.
    employees = [makeEmp('1'), makeEmp('2')];
    now = 1000 + 1000;

    const second = await getDriftCheck({
      loadEmployees: () => ({ data: employees }),
      // Fetcher would throw if called — proves we hit cache.
      fetchVantaResources: async () => { fetchCount++; throw new Error('should not be called'); },
      now: () => now
    });

    assert.strictEqual(fetchCount, 1, 'Vanta should not be re-fetched within TTL');
    assert.strictEqual(second.drift.missing.length, 1, 'new hire should appear as missing');
    assert.strictEqual(second.drift.missing[0].uniqueId, '2');
    assert.strictEqual(second.sourceActiveCount, 2);
    assert.strictEqual(second.vantaActiveCount, 1);
    assert.strictEqual(second.stale, undefined, 'fresh-Vanta-cache hit should not flag stale');
  });

  test('refreshes after TTL when fetch succeeds', async () => {
    let now = 1000;
    let returnedRecords = [makeVantaRecord('1')];
    const employees = [makeEmp('1')];

    await getDriftCheck({
      loadEmployees: () => ({ data: employees }),
      fetchVantaResources: async () => returnedRecords,
      now: () => now
    });

    // Past TTL, fetch returns a different shape — drift should reflect it
    now = 1000 + 2 * 60_000;
    returnedRecords = []; // now Vanta has nothing
    const refreshed = await getDriftCheck({
      loadEmployees: () => ({ data: employees }),
      fetchVantaResources: async () => returnedRecords,
      now: () => now
    });
    assert.strictEqual(refreshed.drift.missing.length, 1);
    assert.strictEqual(refreshed.stale, undefined);
  });
});
