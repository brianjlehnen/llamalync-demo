const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const mockCmdb = require('../src/mockCmdb');
const { loadDevices, _onboard, _decommission, _reassignOwner, _resetMutations } = mockCmdb;

// Every test starts from a clean mutation state. The mock is process-global
// state (mirrors the People-X / Risk-X pattern), so isolation is important.
beforeEach(() => {
  _resetMutations();
});

describe('loadDevices — baseline', () => {
  test('returns the 11-device baseline with stable counts per OS', () => {
    const { data } = loadDevices();
    assert.strictEqual(data.length, 11);
    assert.strictEqual(data.filter(d => d.os === 'macOS').length, 5);
    assert.strictEqual(data.filter(d => d.os === 'Windows').length, 4);
    assert.strictEqual(data.filter(d => d.os === 'Linux').length, 2);
  });

  test('includes Linux source rows so the dashboard can surface "unsupported source row"', () => {
    // The point of Linux records is to show the gap visibly. If this test
    // ever fails by intent (e.g. someone strips Linux from devices.json),
    // the GAP 1 amendment's path (c) — surface in dashboard — is broken.
    const { data } = loadDevices();
    const linux = data.filter(d => d.os === 'Linux');
    assert.ok(linux.length >= 1, 'mock-data/devices.json must keep at least one Linux row for the unsupported demo');
  });

  test('includes orphan devices (assignedEmployeeId: null) for the owner-gap demo', () => {
    const { data } = loadDevices();
    const orphans = data.filter(d => d.assignedEmployeeId === null);
    assert.ok(orphans.length >= 1, 'mock-data/devices.json must keep at least one orphan for the owner-gap demo');
  });

  test('mutationCount is zero on a fresh load (no in-memory mutations applied)', () => {
    const { mutationCount } = loadDevices();
    assert.strictEqual(mutationCount, 0);
  });
});

describe('onboard', () => {
  test('adds a new device with a stable id prefix and increments the counter', () => {
    const first = _onboard();
    assert.match(first.id, /^DEV-NEW-001$/);
    const second = _onboard();
    assert.match(second.id, /^DEV-NEW-002$/);
  });

  test('cycles through the OS pool: macOS → Windows → Linux → macOS', () => {
    const a = _onboard();
    const b = _onboard();
    const c = _onboard();
    const d = _onboard();
    assert.strictEqual(a.os, 'macOS');
    assert.strictEqual(b.os, 'Windows');
    assert.strictEqual(c.os, 'Linux');
    assert.strictEqual(d.os, 'macOS');
  });

  test('macOS template carries applications + drives + isXProtectEnabled', () => {
    const dev = _onboard(); // macOS template (index 0)
    assert.strictEqual(dev.os, 'macOS');
    assert.ok(Array.isArray(dev.applications), 'macOS onboard should populate applications[]');
    assert.ok(dev.applications.length > 0);
    assert.strictEqual(typeof dev.applications[0].bundleId, 'string');
    assert.strictEqual(dev.drives[0].filevaultEnabled, true);
    assert.strictEqual(typeof dev.isXProtectEnabled, 'boolean');
  });

  test('Windows template carries programs + drives + windowsSecurityCenter', () => {
    _onboard(); // macOS, discard
    const dev = _onboard(); // Windows template (index 1)
    assert.strictEqual(dev.os, 'Windows');
    assert.ok(Array.isArray(dev.programs));
    assert.ok(dev.programs.length > 0);
    assert.strictEqual(typeof dev.windowsSecurityCenter.firewall, 'string');
  });

  test('Linux template is leaner (no apps/programs/security center)', () => {
    _onboard(); _onboard(); // skip macOS + Windows
    const dev = _onboard(); // Linux template (index 2)
    assert.strictEqual(dev.os, 'Linux');
    assert.strictEqual(dev.applications, undefined);
    assert.strictEqual(dev.programs, undefined);
    assert.strictEqual(dev.windowsSecurityCenter, undefined);
    // Linux devices still have drives + users (used for Linux-specific
    // display, even though Vanta doesn't push them).
    assert.ok(Array.isArray(dev.drives));
  });

  test('onboarded devices appear in loadDevices() data', () => {
    _onboard();
    _onboard();
    const { data, mutationCount } = loadDevices();
    assert.strictEqual(data.length, 13); // 11 baseline + 2 onboarded
    assert.strictEqual(mutationCount, 2);
  });
});

describe('decommission', () => {
  test('flips status from active → decommissioned with a date stamp', () => {
    const result = _decommission('DEV-MAC-001');
    assert.strictEqual(result.ok, true);
    const { data } = loadDevices();
    const dev = data.find(d => d.id === 'DEV-MAC-001');
    assert.strictEqual(dev.status, 'decommissioned');
    assert.ok(dev.decommissionedAt, 'should record a decommissionedAt date');
  });

  test('returns 404 when the device id does not exist', () => {
    const result = _decommission('DEV-DOES-NOT-EXIST');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
  });

  test('returns 409 when decommissioning an already-decommissioned device (idempotency guard)', () => {
    _decommission('DEV-MAC-001');
    const second = _decommission('DEV-MAC-001');
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.status, 409);
  });

  test('counts toward mutationCount', () => {
    _decommission('DEV-MAC-001');
    const { mutationCount } = loadDevices();
    assert.strictEqual(mutationCount, 1);
  });
});

describe('reassignOwner', () => {
  test('updates assignedEmployeeId to the new value', () => {
    const result = _reassignOwner('DEV-MAC-005', 'emp-002');
    assert.strictEqual(result.ok, true);
    const { data } = loadDevices();
    const dev = data.find(d => d.id === 'DEV-MAC-005');
    assert.strictEqual(dev.assignedEmployeeId, 'emp-002');
  });

  test('null is a valid reassignment (explicitly orphaning a device)', () => {
    const result = _reassignOwner('DEV-MAC-001', null);
    assert.strictEqual(result.ok, true);
    const { data } = loadDevices();
    const dev = data.find(d => d.id === 'DEV-MAC-001');
    assert.strictEqual(dev.assignedEmployeeId, null);
  });

  test('returns 404 when the device id does not exist', () => {
    const result = _reassignOwner('DEV-DOES-NOT-EXIST', 'emp-001');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
  });

  test('rejects reassignment of a decommissioned device (state-machine guard)', () => {
    _decommission('DEV-MAC-001');
    const result = _reassignOwner('DEV-MAC-001', 'emp-002');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 409);
  });
});

describe('resetMutations', () => {
  test('clears every mutation type so the next load is back to baseline', () => {
    _onboard();
    _decommission('DEV-MAC-001');
    _reassignOwner('DEV-MAC-005', 'emp-002');
    assert.strictEqual(loadDevices().mutationCount, 3);
    _resetMutations();
    const { data, mutationCount } = loadDevices();
    assert.strictEqual(mutationCount, 0);
    assert.strictEqual(data.length, 11);
    const dev = data.find(d => d.id === 'DEV-MAC-001');
    assert.strictEqual(dev.status, 'active');
  });
});
