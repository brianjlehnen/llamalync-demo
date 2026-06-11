const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  runPersonnelSync,
  clearPersonnelInVanta,
  transformEmployee,
  buildPersonnelResources,
  safeIsoFromDate
} = require('../src/sync/jobs/personnelSync');

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

// Minimal client double — records put() calls and returns a canned response.
function makeFakeClient() {
  const calls = [];
  return {
    calls,
    put: async (path, body) => {
      calls.push({ path, body });
      return { ok: true };
    }
  };
}

describe('runPersonnelSync — empty-source safety guard', () => {
  let prevResourceId;
  beforeEach(() => {
    prevResourceId = process.env.VANTA_PERSONNEL_RESOURCE_ID;
    process.env.VANTA_PERSONNEL_RESOURCE_ID = 'test-resource-id';
  });
  afterEach(() => {
    if (prevResourceId === undefined) delete process.env.VANTA_PERSONNEL_RESOURCE_ID;
    else process.env.VANTA_PERSONNEL_RESOURCE_ID = prevResourceId;
  });

  test('empty source rejects and does not call buildClient.put', async () => {
    const client = makeFakeClient();
    await assert.rejects(
      runPersonnelSync({
        loadEmployees: () => ({ data: [] }),
        client
      }),
      /Refusing to PUT empty personnel snapshot without allowEmpty=true/
    );
    assert.strictEqual(client.calls.length, 0, 'put should not be called');
  });

  test('all rows skipped (only terminated + service accounts) is treated as empty and blocked', async () => {
    const client = makeFakeClient();
    const employees = [
      makeEmp('1', { status: 'terminated' }),
      makeEmp('2', { isServiceAccount: true }),
      makeEmp('3', { status: 'terminated', isServiceAccount: true })
    ];
    await assert.rejects(
      runPersonnelSync({
        loadEmployees: () => ({ data: employees }),
        client
      }),
      /Refusing to PUT empty personnel snapshot without allowEmpty=true/
    );
    assert.strictEqual(client.calls.length, 0, 'put should not be called');
  });

  test('non-empty source PUTs normally', async () => {
    const client = makeFakeClient();
    const result = await runPersonnelSync({
      loadEmployees: () => ({ data: [makeEmp('1'), makeEmp('2')] }),
      client
    });
    assert.strictEqual(client.calls.length, 1);
    assert.strictEqual(client.calls[0].path, '/v1/resources/user_account');
    assert.strictEqual(client.calls[0].body.resourceId, 'test-resource-id');
    assert.strictEqual(client.calls[0].body.resources.length, 2);
    assert.strictEqual(result.pushed, 2);
  });

  test('non-empty source with terminated/service-account rows pushes only active ones', async () => {
    const client = makeFakeClient();
    const employees = [
      makeEmp('1'),
      makeEmp('2', { status: 'terminated' }),
      makeEmp('3', { isServiceAccount: true })
    ];
    const result = await runPersonnelSync({
      loadEmployees: () => ({ data: employees }),
      client
    });
    assert.strictEqual(client.calls.length, 1);
    assert.strictEqual(client.calls[0].body.resources.length, 1);
    assert.strictEqual(client.calls[0].body.resources[0].uniqueId, '1');
    assert.deepStrictEqual(result.skipped, { terminated: 1, serviceAccounts: 1 });
  });

  test('allowEmpty=true permits an empty PUT', async () => {
    const client = makeFakeClient();
    const result = await runPersonnelSync({
      allowEmpty: true,
      loadEmployees: () => ({ data: [] }),
      client
    });
    assert.strictEqual(client.calls.length, 1);
    assert.deepStrictEqual(client.calls[0].body.resources, []);
    assert.strictEqual(result.pushed, 0);
  });
});

describe('clearPersonnelInVanta — reset/clear path', () => {
  let prevResourceId;
  beforeEach(() => {
    prevResourceId = process.env.VANTA_PERSONNEL_RESOURCE_ID;
    process.env.VANTA_PERSONNEL_RESOURCE_ID = 'test-resource-id';
  });
  afterEach(() => {
    if (prevResourceId === undefined) delete process.env.VANTA_PERSONNEL_RESOURCE_ID;
    else process.env.VANTA_PERSONNEL_RESOURCE_ID = prevResourceId;
  });

  test('still sends resources: [] (bypasses the safety guard)', async () => {
    const client = makeFakeClient();
    const result = await clearPersonnelInVanta({ client });
    assert.strictEqual(client.calls.length, 1);
    assert.strictEqual(client.calls[0].path, '/v1/resources/user_account');
    assert.deepStrictEqual(client.calls[0].body.resources, []);
    assert.strictEqual(client.calls[0].body.resourceId, 'test-resource-id');
    assert.strictEqual(result.cleared, true);
  });
});

describe('safeIsoFromDate', () => {
  test('valid ISO string round-trips to ISO', () => {
    assert.strictEqual(
      safeIsoFromDate('2024-01-01T00:00:00Z'),
      '2024-01-01T00:00:00.000Z'
    );
  });

  test('YYYY-MM-DD string is normalized to UTC midnight ISO', () => {
    assert.strictEqual(safeIsoFromDate('2024-01-01'), '2024-01-01T00:00:00.000Z');
  });

  test('undefined returns null (no throw)', () => {
    assert.doesNotThrow(() => safeIsoFromDate(undefined));
    assert.strictEqual(safeIsoFromDate(undefined), null);
  });

  test('null returns null', () => {
    assert.strictEqual(safeIsoFromDate(null), null);
  });

  test('empty string returns null', () => {
    assert.strictEqual(safeIsoFromDate(''), null);
  });

  test('unparseable date string returns null (no throw)', () => {
    assert.doesNotThrow(() => safeIsoFromDate('not-a-date'));
    assert.strictEqual(safeIsoFromDate('not-a-date'), null);
  });

  test('out-of-range date string returns null', () => {
    assert.strictEqual(safeIsoFromDate('2026-13-99'), null);
  });
});

describe('transformEmployee — startDate guard (D1)', () => {
  // Regression: `new Date(undefined).toISOString()` throws RangeError, so a
  // single row with a missing startDate aborted the entire `.map()` and
  // wiped the whole sync. Each call below MUST return a valid payload.

  test('missing startDate produces null createdTimestamp (no throw)', () => {
    const out = transformEmployee({
      id: 'emp-x',
      email: 'x@y.com',
      firstName: 'X',
      lastName: 'Y'
      // no startDate
    });
    assert.strictEqual(out.createdTimestamp, null);
    assert.strictEqual(out.uniqueId, 'emp-x');
  });

  test('invalid startDate string produces null createdTimestamp', () => {
    const out = transformEmployee({
      id: 'emp-x',
      email: 'x@y.com',
      firstName: 'X',
      lastName: 'Y',
      startDate: 'not-a-date'
    });
    assert.strictEqual(out.createdTimestamp, null);
  });

  test('valid startDate produces ISO createdTimestamp', () => {
    const out = transformEmployee({
      id: 'emp-x',
      email: 'x@y.com',
      firstName: 'X',
      lastName: 'Y',
      startDate: '2024-03-15'
    });
    assert.strictEqual(out.createdTimestamp, '2024-03-15T00:00:00.000Z');
  });

  test('buildPersonnelResources does not throw when one row has bad startDate', () => {
    const employees = [
      { id: 'emp-1', email: 'a@x.com', firstName: 'A', lastName: '1', startDate: '2024-01-01', status: 'active', isServiceAccount: false },
      { id: 'emp-2', email: 'b@x.com', firstName: 'B', lastName: '2', /* no startDate */ status: 'active', isServiceAccount: false },
      { id: 'emp-3', email: 'c@x.com', firstName: 'C', lastName: '3', startDate: '2025-06-01', status: 'active', isServiceAccount: false }
    ];
    let result;
    assert.doesNotThrow(() => { result = buildPersonnelResources(employees); });
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[1].createdTimestamp, null);
    assert.strictEqual(result[0].createdTimestamp, '2024-01-01T00:00:00.000Z');
  });
});

describe('transformEmployee — lastLoginTimestamp from source (D2)', () => {
  // Regression: the prior code did `lastLoginTimestamp: new Date().toISOString()`
  // — synthesized a fresh "logged in just now" on every sync. That masked
  // dormant accounts in any downstream test that uses this field, e.g.
  // "users who haven't logged in in 90 days".

  function emp(overrides = {}) {
    return {
      id: 'emp-001',
      email: 'a@x.com',
      firstName: 'A',
      lastName: 'X',
      startDate: '2024-01-01',
      status: 'active',
      isServiceAccount: false,
      ...overrides
    };
  }

  test('emp.lastLogin populated → forwarded as ISO timestamp', () => {
    const out = transformEmployee(emp({ lastLogin: '2026-04-10T14:23:00Z' }));
    assert.strictEqual(out.lastLoginTimestamp, '2026-04-10T14:23:00.000Z');
  });

  test('emp.lastLoginAt (alternate shape) → forwarded', () => {
    const out = transformEmployee(emp({ lastLoginAt: '2026-04-10T14:23:00Z' }));
    assert.strictEqual(out.lastLoginTimestamp, '2026-04-10T14:23:00.000Z');
  });

  test('lastLogin takes precedence when both fields are present', () => {
    const out = transformEmployee(emp({
      lastLogin:   '2026-05-01T00:00:00Z',
      lastLoginAt: '2026-04-01T00:00:00Z'
    }));
    assert.strictEqual(out.lastLoginTimestamp, '2026-05-01T00:00:00.000Z');
  });

  test('no lastLogin field at all → null (no synthetic now)', () => {
    const out = transformEmployee(emp());
    assert.strictEqual(out.lastLoginTimestamp, null);
  });

  test('invalid lastLogin string → null (does not throw)', () => {
    const out = transformEmployee(emp({ lastLogin: 'not-a-date' }));
    assert.strictEqual(out.lastLoginTimestamp, null);
  });

  test('null lastLogin → null', () => {
    const out = transformEmployee(emp({ lastLogin: null }));
    assert.strictEqual(out.lastLoginTimestamp, null);
  });

  test('two transforms in quick succession produce stable nulls (no time-of-call drift)', () => {
    // Sanity check the synthetic-now regression: running transform twice
    // with the same input should produce identical output. The old code
    // produced slightly different lastLoginTimestamps each call.
    const e = emp();
    const a = transformEmployee(e);
    const b = transformEmployee(e);
    assert.strictEqual(a.lastLoginTimestamp, b.lastLoginTimestamp);
  });
});

describe('buildPersonnelResources — uniqueId dedupe (D4)', () => {
  function emp(id, overrides = {}) {
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

  test('no duplicates → all rows pass through unchanged', () => {
    const result = buildPersonnelResources([emp('emp-1'), emp('emp-2'), emp('emp-3')]);
    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result.map(r => r.uniqueId), ['emp-1', 'emp-2', 'emp-3']);
  });

  test('duplicate id → first occurrence wins, second dropped', () => {
    const result = buildPersonnelResources([
      emp('emp-1', { email: 'first@x.com' }),
      emp('emp-1', { email: 'second@x.com' }),
      emp('emp-2')
    ]);
    assert.strictEqual(result.length, 2);
    // Find the emp-1 entry — should be the first occurrence's email.
    const a = result.find(r => r.uniqueId === 'emp-1');
    assert.strictEqual(a.email, 'first@x.com', 'first occurrence wins');
    assert.ok(result.find(r => r.uniqueId === 'emp-2'));
  });

  test('three duplicates of the same id → only the first survives', () => {
    const result = buildPersonnelResources([
      emp('emp-1', { email: 'first@x.com' }),
      emp('emp-1', { email: 'second@x.com' }),
      emp('emp-1', { email: 'third@x.com' })
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].email, 'first@x.com');
  });

  test('terminated + service-account filters apply before dedupe — they cant resurrect a dropped dup', () => {
    // If the first occurrence is filtered out (e.g. terminated), the second
    // occurrence is still seen as "first" by the dedupe and kept. This is
    // the correct interaction: filter then dedupe.
    const result = buildPersonnelResources([
      emp('emp-1', { status: 'terminated', email: 'terminated@x.com' }),
      emp('emp-1', { email: 'rehire@x.com' })
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].email, 'rehire@x.com');
  });
});
