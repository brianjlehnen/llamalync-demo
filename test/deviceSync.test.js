const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  runDeviceSync,
  clearDevicesInVanta,
  transformMacosDevice,
  transformWindowsDevice,
  bucketDevices,
  resolveOwnerEmail
} = require('../src/sync/jobs/deviceSync');

// ─── Helpers ────────────────────────────────────────────────────────────────

// Minimal device records covering every per-platform required input.
// Mirrors the shape used in mock-data/devices.json without depending on the
// real file — keeps tests isolated from baseline-data drift.
function macDevice(overrides = {}) {
  return {
    id: 'DEV-MAC-T1',
    hostname: 'test-mac',
    serialNumber: 'TST-SERIAL-MAC',
    os: 'macOS',
    osVersion: '14.2.1',
    hardwareUuid: 'TST-UUID-MAC',
    assignedEmployeeId: 'emp-001',
    lastSeen: '2026-05-13T08:00:00Z',
    status: 'active',
    isManaged: true,
    autoUpdatesEnabled: true,
    applications: [
      { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', lastOpenedAt: '2026-05-13T07:00:00Z' }
    ],
    browserExtensions: [{ extensionId: 'ext-1', name: 'TestExt', browser: 'CHROME' }],
    drives: [{ name: 'Macintosh HD', encrypted: true, filevaultEnabled: true, isBootVolume: true }],
    users: [{
      username: 'tester',
      screenlockPolicies: [{ requiresPassword: true, screenSleepTimeoutMs: 300000 }],
      screenlockSettings: { requiresPassword: true, screenSleepTimeoutMs: 300000 },
      lastLoginAt: '2026-05-13T08:00:00Z'
    }],
    systemScreenlockPolicies: [{ requiresPassword: true, screenSleepTimeoutMs: 300000 }],
    passwordPolicy: { minimumLengthRequirement: 12 },
    lastEnrolledAt: '2024-03-15T10:00:00Z',
    isXProtectEnabled: true,
    ...overrides
  };
}

function winDevice(overrides = {}) {
  return {
    id: 'DEV-WIN-T1',
    hostname: 'test-win',
    serialNumber: 'TST-SERIAL-WIN',
    os: 'Windows',
    osVersion: '11.23H2',
    hardwareUuid: 'TST-UUID-WIN',
    assignedEmployeeId: 'emp-002',
    lastSeen: '2026-05-13T08:00:00Z',
    status: 'active',
    isManaged: true,
    autoUpdatesEnabled: true,
    programs: [{ name: 'Microsoft Edge', lastOpenedAt: '2026-05-13T07:00:00Z' }],
    browserExtensions: [],
    drives: [{ name: 'C:', encrypted: true, isBootVolume: true }],
    users: [{
      username: 'tester',
      screenlockPolicies: [{ requiresPassword: true, screenSleepTimeoutMs: 300000 }],
      screenlockSettings: { requiresPassword: true, screenSleepTimeoutMs: 300000 },
      lastLoginAt: '2026-05-13T08:00:00Z'
    }],
    systemScreenlockPolicies: [{ requiresPassword: true, screenSleepTimeoutMs: 300000 }],
    windowsSecurityCenter: {
      firewall: 'GOOD', autoupdate: 'GOOD', antivirus: 'GOOD',
      internetSetting: 'GOOD', userAccountControl: 'GOOD',
      windowsSecurityCenterService: 'GOOD'
    },
    windowsSecurityProducts: [{
      name: 'Defender', category: 'ANTIVIRUS', state: 'ON',
      stateTimestamp: '2026-05-13T08:00:00Z', signaturesUpToDate: true
    }],
    ...overrides
  };
}

function linuxDevice(overrides = {}) {
  return {
    id: 'DEV-LIN-T1',
    hostname: 'test-linux',
    serialNumber: 'TST-SERIAL-LIN',
    os: 'Linux',
    osVersion: 'Ubuntu 22.04 LTS',
    hardwareUuid: 'TST-UUID-LIN',
    assignedEmployeeId: 'emp-001',
    lastSeen: '2026-05-13T08:00:00Z',
    status: 'active',
    isManaged: false,
    autoUpdatesEnabled: true,
    drives: [{ name: '/dev/sda1', encrypted: true, isBootVolume: true }],
    users: [{ username: 'tester', lastLoginAt: '2026-05-13T08:00:00Z' }],
    ...overrides
  };
}

function emp(id, email) {
  return { id, email, firstName: 'T', lastName: 'X', status: 'active', isServiceAccount: false };
}

// Stub vantaClient — records PUT calls without touching the network.
function stubClient(responseBody = { success: true }) {
  const calls = [];
  return {
    calls,
    async put(path, body) {
      calls.push({ path, body });
      return responseBody;
    }
  };
}

// Convenience: build a runDeviceSync option block with safe defaults.
function syncOpts({ devices = [], employees = [], vantaClient = stubClient() } = {}) {
  return {
    loadDevices:       () => ({ data: devices }),
    loadEmployees:     () => ({ data: employees }),
    vantaClient,
    macosResourceId:   'res-mac-123',
    windowsResourceId: 'res-win-123'
  };
}

// ─── resolveOwnerEmail ──────────────────────────────────────────────────────

describe('resolveOwnerEmail', () => {
  const emailById = new Map([['emp-001', 'alice@example.com']]);

  test('known employee id resolves to email', () => {
    assert.strictEqual(
      resolveOwnerEmail({ assignedEmployeeId: 'emp-001' }, emailById),
      'alice@example.com'
    );
  });

  test('null assignedEmployeeId returns null (orphan device)', () => {
    assert.strictEqual(
      resolveOwnerEmail({ assignedEmployeeId: null }, emailById),
      null
    );
  });

  test('undefined assignedEmployeeId returns null', () => {
    assert.strictEqual(resolveOwnerEmail({}, emailById), null);
  });

  test('unknown employee id returns null (stale CMDB pointer; not a hard fail)', () => {
    // The owner field is nullable per the JTD schema, so pushing null is safe.
    // Sending an unresolvable email risks a 422 against Vanta's People lookup.
    assert.strictEqual(
      resolveOwnerEmail({ assignedEmployeeId: 'emp-departed-2019' }, emailById),
      null
    );
  });
});

// ─── transformMacosDevice ───────────────────────────────────────────────────

describe('transformMacosDevice', () => {
  const emailById = new Map([['emp-001', 'alice@example.com']]);

  test('produces every required schema field for MacosUserComputer', () => {
    const out = transformMacosDevice(macDevice(), { emailById });
    // The 15 required JTD properties per the macOS schema. NOTE: the
    // Dev Console JTD schema also lists `customProperties` under
    // `properties` (= required per JTD), but Vanta's runtime validator
    // REJECTS it as "Extra keys" (smoke test 2026-05-14). The transform
    // deliberately omits it; this list reflects the validator's actual
    // expectations, not the published JTD.
    const required = [
      'displayName', 'uniqueId', 'externalUrl', 'collectedTimestamp',
      'osName', 'osVersion', 'hardwareUuid', 'serialNumber',
      'applications', 'browserExtensions', 'drives', 'users',
      'systemScreenlockPolicies', 'isManaged', 'autoUpdatesEnabled'
    ];
    for (const f of required) {
      assert.ok(f in out, `transform output missing required field: ${f}`);
    }
  });

  test('uses uniqueId (not externalId) as the identity field', () => {
    const out = transformMacosDevice(macDevice(), { emailById });
    assert.strictEqual(out.uniqueId, 'DEV-MAC-T1');
    assert.strictEqual(out.externalId, undefined, 'externalId must NOT be sent');
  });

  test('sets osName="macOS"', () => {
    const out = transformMacosDevice(macDevice(), { emailById });
    assert.strictEqual(out.osName, 'macOS');
  });

  test('applications carry bundleId (required per macOS schema, distinct from Windows)', () => {
    const out = transformMacosDevice(macDevice(), { emailById });
    assert.strictEqual(out.applications[0].name, 'Slack');
    assert.strictEqual(out.applications[0].bundleId, 'com.tinyspeck.slackmacgap');
  });

  test('renames source lastOpenedAt → lastOpenedTimestamp (only when present)', () => {
    const withTs = transformMacosDevice(macDevice(), { emailById });
    assert.strictEqual(withTs.applications[0].lastOpenedTimestamp, '2026-05-13T07:00:00Z');

    const withoutTs = transformMacosDevice(
      macDevice({ applications: [{ name: 'X', bundleId: 'com.x' }] }),
      { emailById }
    );
    assert.strictEqual('lastOpenedTimestamp' in withoutTs.applications[0], false);
  });

  test('drives include filevaultEnabled (macOS-specific)', () => {
    const out = transformMacosDevice(macDevice(), { emailById });
    assert.strictEqual(out.drives[0].filevaultEnabled, true);
  });

  test('owner resolves from People-X via emailById', () => {
    const out = transformMacosDevice(macDevice(), { emailById });
    assert.strictEqual(out.owner, 'alice@example.com');
  });

  test('owner is null for orphan devices (assignedEmployeeId: null)', () => {
    const out = transformMacosDevice(macDevice({ assignedEmployeeId: null }), { emailById });
    assert.strictEqual(out.owner, null);
  });

  test('owner is null for unknown employee id (avoids 422 against People lookup)', () => {
    const out = transformMacosDevice(
      macDevice({ assignedEmployeeId: 'emp-departed-2019' }),
      { emailById }
    );
    assert.strictEqual(out.owner, null);
  });

  test('customProperties is OMITTED — Vanta validator rejects it as "Extra keys" despite JTD declaring it required (smoke test 2026-05-14)', () => {
    const out = transformMacosDevice(macDevice(), { emailById });
    assert.strictEqual('customProperties' in out, false);
  });

  test('isXProtectEnabled passes through; null when absent', () => {
    const a = transformMacosDevice(macDevice({ isXProtectEnabled: false }), { emailById });
    assert.strictEqual(a.isXProtectEnabled, false);
    const b = transformMacosDevice(macDevice({ isXProtectEnabled: undefined }), { emailById });
    assert.strictEqual(b.isXProtectEnabled, null);
  });

  test('users[].lastLoginTimestamp present when source has lastLoginAt; absent otherwise', () => {
    const withLogin = transformMacosDevice(macDevice(), { emailById });
    assert.strictEqual(withLogin.users[0].lastLoginTimestamp, '2026-05-13T08:00:00Z');

    const withoutLogin = transformMacosDevice(
      macDevice({
        users: [{
          username: 'noLastLogin',
          screenlockPolicies: [],
          screenlockSettings: { requiresPassword: true, screenSleepTimeoutMs: 1 }
        }]
      }),
      { emailById }
    );
    assert.strictEqual('lastLoginTimestamp' in withoutLogin.users[0], false);
  });

  test('collectedTimestamp comes from source lastSeen (when the device was observed)', () => {
    const out = transformMacosDevice(macDevice(), { emailById });
    assert.strictEqual(out.collectedTimestamp, '2026-05-13T08:00:00Z');
  });
});

// ─── transformWindowsDevice ─────────────────────────────────────────────────

describe('transformWindowsDevice', () => {
  const emailById = new Map([['emp-002', 'bob@example.com']]);

  test('uses programs (not applications) as the inventory field', () => {
    const out = transformWindowsDevice(winDevice(), { emailById });
    assert.ok(Array.isArray(out.programs));
    assert.strictEqual(out.applications, undefined, 'Windows transform must NOT emit applications');
  });

  test('programs do NOT require bundleId (Windows schema diff vs macOS)', () => {
    const out = transformWindowsDevice(winDevice(), { emailById });
    assert.strictEqual(out.programs[0].name, 'Microsoft Edge');
    assert.strictEqual('bundleId' in out.programs[0], false);
  });

  test('drives do NOT include filevaultEnabled (macOS-only field)', () => {
    const out = transformWindowsDevice(winDevice(), { emailById });
    assert.strictEqual('filevaultEnabled' in out.drives[0], false);
  });

  test('sets osName="Windows"', () => {
    const out = transformWindowsDevice(winDevice(), { emailById });
    assert.strictEqual(out.osName, 'Windows');
  });

  test('windowsSecurityCenter passes through with all six enum-rated signals', () => {
    const out = transformWindowsDevice(winDevice(), { emailById });
    assert.strictEqual(out.windowsSecurityCenter.firewall, 'GOOD');
    assert.strictEqual(out.windowsSecurityCenter.userAccountControl, 'GOOD');
    assert.strictEqual(out.windowsSecurityCenter.windowsSecurityCenterService, 'GOOD');
  });

  test('windowsSecurityProducts passes through; null when absent', () => {
    const present = transformWindowsDevice(winDevice(), { emailById });
    assert.strictEqual(present.windowsSecurityProducts.length, 1);

    const absent = transformWindowsDevice(winDevice({ windowsSecurityProducts: undefined }), { emailById });
    assert.strictEqual(absent.windowsSecurityProducts, null);
  });

  test('customProperties is OMITTED (same as macOS — validator rejects despite JTD declaration)', () => {
    const out = transformWindowsDevice(winDevice(), { emailById });
    assert.strictEqual('customProperties' in out, false);
  });

  test('owner resolves from People-X via emailById', () => {
    const out = transformWindowsDevice(winDevice(), { emailById });
    assert.strictEqual(out.owner, 'bob@example.com');
  });
});

// ─── bucketDevices ──────────────────────────────────────────────────────────

describe('bucketDevices', () => {
  test('splits a mixed roster into macos / windows / linuxUnsupported / decommissioned', () => {
    const devices = [
      macDevice({ id: 'M1' }),
      winDevice({ id: 'W1' }),
      linuxDevice({ id: 'L1' }),
      macDevice({ id: 'M2', status: 'decommissioned' })
    ];
    const buckets = bucketDevices(devices);
    assert.strictEqual(buckets.macos.length, 1);
    assert.strictEqual(buckets.windows.length, 1);
    assert.strictEqual(buckets.linuxUnsupported.length, 1);
    assert.strictEqual(buckets.decommissioned.length, 1);
    assert.strictEqual(buckets.macos[0].id, 'M1');
    assert.strictEqual(buckets.decommissioned[0].id, 'M2');
  });

  test('decommissioned macOS device is excluded from the macos bucket (drops out of PUT)', () => {
    const devices = [
      macDevice({ id: 'M1', status: 'active' }),
      macDevice({ id: 'M2', status: 'decommissioned' })
    ];
    const buckets = bucketDevices(devices);
    assert.strictEqual(buckets.macos.length, 1);
    assert.strictEqual(buckets.macos[0].id, 'M1');
  });
});

// ─── runDeviceSync ──────────────────────────────────────────────────────────

describe('runDeviceSync — env fail-fast', () => {
  test('throws when VANTA_MACOS_RESOURCE_ID is missing', async () => {
    await assert.rejects(
      () => runDeviceSync({ ...syncOpts(), macosResourceId: undefined }),
      /VANTA_MACOS_RESOURCE_ID must be set/
    );
  });

  test('throws when VANTA_WINDOWS_RESOURCE_ID is missing', async () => {
    await assert.rejects(
      () => runDeviceSync({ ...syncOpts(), windowsResourceId: undefined }),
      /VANTA_WINDOWS_RESOURCE_ID must be set/
    );
  });
});

describe('runDeviceSync — empty-source safety guard', () => {
  // Full-snapshot PUT semantics: a transient empty source would soft-delete
  // every device Vanta holds. Personnel sync has this guard; devices added
  // it as the same incident class. Guard fires only when the SOURCE went
  // silent (zero active macOS + zero active Windows + zero unsupported
  // Linux) — a legitimately Windows-less customer is fine.

  test('refuses to PUT when the entire active source is empty', async () => {
    const client = stubClient();
    await assert.rejects(
      () => runDeviceSync(syncOpts({ devices: [], employees: [], vantaClient: client })),
      /Refusing to PUT empty device snapshot/
    );
    assert.strictEqual(client.calls.length, 0, 'no PUTs were issued');
  });

  test('refuses to PUT when every device is decommissioned (no active rows)', async () => {
    const client = stubClient();
    await assert.rejects(
      () => runDeviceSync(syncOpts({
        devices: [
          macDevice({ id: 'M-DECOM', status: 'decommissioned' }),
          winDevice({ id: 'W-DECOM', status: 'decommissioned' })
        ],
        employees: [],
        vantaClient: client
      })),
      /Refusing to PUT empty device snapshot/
    );
    assert.strictEqual(client.calls.length, 0);
  });

  test('allows a Windows-less customer (zero Windows, macOS active) — not the scary case', async () => {
    // The guard MUST NOT block this case. A real customer with only macOS
    // devices would push macOS rows + an empty Windows snapshot every run.
    // The empty Windows PUT is intentional (full-snapshot semantics keep
    // Vanta in sync with the source).
    const client = stubClient();
    const stats = await runDeviceSync(syncOpts({
      devices: [macDevice()],
      employees: [emp('emp-001', 'a@e.com')],
      vantaClient: client
    }));
    assert.strictEqual(stats.pushed.macos, 1);
    assert.strictEqual(stats.pushed.windows, 0);
    assert.strictEqual(client.calls.length, 2, 'both platform PUTs still fire');
  });

  test('allows a macOS-less customer (zero macOS, Windows active) — symmetric case', async () => {
    const client = stubClient();
    const stats = await runDeviceSync(syncOpts({
      devices: [winDevice()],
      employees: [emp('emp-002', 'b@e.com')],
      vantaClient: client
    }));
    assert.strictEqual(stats.pushed.macos, 0);
    assert.strictEqual(stats.pushed.windows, 1);
  });

  test('allows allowEmpty=true to bypass the guard (explicit destructive intent)', async () => {
    const client = stubClient();
    const stats = await runDeviceSync({
      ...syncOpts({ devices: [], employees: [], vantaClient: client }),
      allowEmpty: true
    });
    assert.strictEqual(stats.pushed.macos, 0);
    assert.strictEqual(stats.pushed.windows, 0);
    assert.strictEqual(client.calls.length, 2, 'both empty PUTs fire under the bypass');
  });

  test('treats a Linux-only source as non-empty (source is alive even if no pushable rows)', async () => {
    // Linux rows are surfaced as unsupported in the dashboard, NOT pushed.
    // But their presence proves the source isn't silent — guard should
    // pass them through and issue two empty platform PUTs (intentional:
    // keeps Vanta synced with a real source state of "everyone is Linux").
    const client = stubClient();
    const stats = await runDeviceSync(syncOpts({
      devices: [linuxDevice({ id: 'L1' })],
      employees: [],
      vantaClient: client
    }));
    assert.strictEqual(stats.pushed.macos, 0);
    assert.strictEqual(stats.pushed.windows, 0);
    assert.strictEqual(stats.unsupportedLinuxRows.length, 1);
    assert.strictEqual(client.calls.length, 2);
  });
});

describe('runDeviceSync — PUT routing', () => {
  test('issues exactly two PUTs: MacosUserComputer + WindowsUserComputer', async () => {
    const client = stubClient();
    await runDeviceSync(syncOpts({
      devices: [macDevice(), winDevice(), linuxDevice()],
      employees: [emp('emp-001', 'alice@e.com'), emp('emp-002', 'bob@e.com')],
      vantaClient: client
    }));
    assert.strictEqual(client.calls.length, 2);
    const paths = client.calls.map(c => c.path);
    assert.ok(paths.includes('/v1/resources/MacosUserComputer'));
    assert.ok(paths.includes('/v1/resources/WindowsUserComputer'));
  });

  test('Linux devices are excluded from BOTH PUT payloads', async () => {
    const client = stubClient();
    await runDeviceSync(syncOpts({
      devices: [macDevice(), winDevice(), linuxDevice({ id: 'L-NOTPUSHED' })],
      employees: [emp('emp-001', 'a@e.com'), emp('emp-002', 'b@e.com')],
      vantaClient: client
    }));
    for (const call of client.calls) {
      const uniqueIds = call.body.resources.map(r => r.uniqueId);
      assert.strictEqual(
        uniqueIds.includes('L-NOTPUSHED'), false,
        `Linux device L-NOTPUSHED appeared in PUT to ${call.path}`
      );
    }
  });

  test('decommissioned devices are excluded from PUT payloads (drop out for soft-delete)', async () => {
    const client = stubClient();
    await runDeviceSync(syncOpts({
      devices: [
        macDevice({ id: 'M-ACTIVE' }),
        macDevice({ id: 'M-DECOM', status: 'decommissioned' })
      ],
      employees: [emp('emp-001', 'a@e.com')],
      vantaClient: client
    }));
    const macCall = client.calls.find(c => c.path === '/v1/resources/MacosUserComputer');
    const uniqueIds = macCall.body.resources.map(r => r.uniqueId);
    assert.ok(uniqueIds.includes('M-ACTIVE'));
    assert.strictEqual(uniqueIds.includes('M-DECOM'), false);
  });

  test('macOS PUT body carries the macosResourceId, Windows PUT carries the windowsResourceId', async () => {
    const client = stubClient();
    await runDeviceSync(syncOpts({
      devices: [macDevice(), winDevice()],
      employees: [emp('emp-001', 'a@e.com'), emp('emp-002', 'b@e.com')],
      vantaClient: client
    }));
    const macCall = client.calls.find(c => c.path === '/v1/resources/MacosUserComputer');
    const winCall = client.calls.find(c => c.path === '/v1/resources/WindowsUserComputer');
    assert.strictEqual(macCall.body.resourceId, 'res-mac-123');
    assert.strictEqual(winCall.body.resourceId, 'res-win-123');
  });
});

describe('runDeviceSync — stats', () => {
  test('reports pushed counts per platform', async () => {
    const stats = await runDeviceSync(syncOpts({
      devices: [macDevice(), macDevice({ id: 'M2' }), winDevice()],
      employees: [emp('emp-001', 'a@e.com'), emp('emp-002', 'b@e.com')]
    }));
    assert.strictEqual(stats.pushed.macos, 2);
    assert.strictEqual(stats.pushed.windows, 1);
  });

  test('reports orphan counts per platform', async () => {
    const stats = await runDeviceSync(syncOpts({
      devices: [
        macDevice(),                                          // owned
        macDevice({ id: 'M2', assignedEmployeeId: null }),    // orphan
        winDevice({ assignedEmployeeId: 'emp-unknown' })      // unknown id → null owner = orphan
      ],
      employees: [emp('emp-001', 'a@e.com')]
    }));
    assert.strictEqual(stats.orphans.macos, 1);
    assert.strictEqual(stats.orphans.windows, 1);
  });

  test('reports skipped buckets (linuxUnsupported + decommissioned)', async () => {
    const stats = await runDeviceSync(syncOpts({
      devices: [
        macDevice(),
        linuxDevice({ id: 'L1' }),
        linuxDevice({ id: 'L2' }),
        winDevice({ status: 'decommissioned' })
      ],
      employees: [emp('emp-001', 'a@e.com'), emp('emp-002', 'b@e.com')]
    }));
    assert.strictEqual(stats.skipped.linuxUnsupported, 2);
    assert.strictEqual(stats.skipped.decommissioned, 1);
  });

  test('surfaces the Linux rows for dashboard "unsupported source row" rendering', async () => {
    const stats = await runDeviceSync(syncOpts({
      devices: [linuxDevice({ id: 'L1', hostname: 'linux-1' })],
      employees: []
    }));
    assert.strictEqual(stats.unsupportedLinuxRows.length, 1);
    assert.strictEqual(stats.unsupportedLinuxRows[0].id, 'L1');
    assert.strictEqual(stats.unsupportedLinuxRows[0].hostname, 'linux-1');
  });
});

// ─── runDeviceSync — partial-failure handling ─────────────────────────────

// Stub that fails on a specific path and succeeds elsewhere. Lets us test
// macOS-fails-Windows-succeeds, Windows-fails-macOS-succeeds, both-fail
// independently without the test reaching into Vanta.
function stubClientFailing(failOnPath, errorMessage = 'simulated 500') {
  const calls = [];
  return {
    calls,
    async put(path, body) {
      calls.push({ path, body });
      if (path === failOnPath) {
        const err = new Error(errorMessage);
        err.statusCode = 500;
        throw err;
      }
      return { success: true };
    }
  };
}

describe('runDeviceSync — partial failure (the original bug)', () => {
  test('Windows fails after macOS succeeds — caller sees both outcomes via err.stats', async () => {
    const client = stubClientFailing('/v1/resources/WindowsUserComputer', 'windows 500');
    const opts = syncOpts({
      devices: [macDevice({ assignedEmployeeId: 'emp-001' }), winDevice({ assignedEmployeeId: 'emp-001' })],
      employees: [emp('emp-001', 'a@x.com')],
      vantaClient: client
    });

    let thrown;
    try { await runDeviceSync(opts); } catch (e) { thrown = e; }

    assert.ok(thrown, 'should throw on partial failure');
    assert.strictEqual(thrown.partial, true);
    assert.match(thrown.message, /Windows/);
    assert.strictEqual(thrown.stats.pushed.macos, 1, 'macOS pushed count survived');
    assert.strictEqual(thrown.stats.pushed.windows, 0, 'Windows pushed=0 on failure');
    assert.strictEqual(thrown.stats.attempted.windows, 1);
    assert.strictEqual(thrown.stats.failures.macos, null);
    assert.match(thrown.stats.failures.windows, /windows 500/);
    // Critically — both PUTs were actually attempted. macOS already mutated
    // Vanta; the caller MUST know that to triage correctly.
    assert.strictEqual(client.calls.length, 2);
  });

  test('macOS fails — Windows PUT is still attempted', async () => {
    const client = stubClientFailing('/v1/resources/MacosUserComputer', 'macos 429');
    const opts = syncOpts({
      devices: [macDevice({ assignedEmployeeId: 'emp-001' }), winDevice({ assignedEmployeeId: 'emp-001' })],
      employees: [emp('emp-001', 'a@x.com')],
      vantaClient: client
    });

    let thrown;
    try { await runDeviceSync(opts); } catch (e) { thrown = e; }

    assert.ok(thrown);
    assert.strictEqual(thrown.partial, true);
    assert.strictEqual(thrown.stats.pushed.macos, 0);
    assert.strictEqual(thrown.stats.pushed.windows, 1, 'Windows still pushed after macOS failure');
    assert.match(thrown.stats.failures.macos, /macos 429/);
    assert.strictEqual(thrown.stats.failures.windows, null);
    assert.strictEqual(client.calls.length, 2);
  });

  test('both fail — partial=false, both error messages captured', async () => {
    // Client that throws on every PUT.
    const client = {
      calls: [],
      async put(path, body) {
        this.calls.push({ path, body });
        throw new Error(`fail on ${path}`);
      }
    };
    const opts = syncOpts({
      devices: [macDevice({ assignedEmployeeId: 'emp-001' }), winDevice({ assignedEmployeeId: 'emp-001' })],
      employees: [emp('emp-001', 'a@x.com')],
      vantaClient: client
    });

    let thrown;
    try { await runDeviceSync(opts); } catch (e) { thrown = e; }

    assert.ok(thrown);
    assert.strictEqual(thrown.partial, false, 'no partial success when both fail');
    assert.match(thrown.stats.failures.macos, /MacosUserComputer/);
    assert.match(thrown.stats.failures.windows, /WindowsUserComputer/);
    assert.strictEqual(client.calls.length, 2);
  });

  test('both succeed — no throw, failures.{macos,windows} are null', async () => {
    const client = stubClient();
    const opts = syncOpts({
      devices: [macDevice({ assignedEmployeeId: 'emp-001' }), winDevice({ assignedEmployeeId: 'emp-001' })],
      employees: [emp('emp-001', 'a@x.com')],
      vantaClient: client
    });
    const stats = await runDeviceSync(opts);
    assert.strictEqual(stats.failures.macos, null);
    assert.strictEqual(stats.failures.windows, null);
    assert.strictEqual(stats.attempted.macos, 1);
    assert.strictEqual(stats.attempted.windows, 1);
  });
});

// ─── clearDevicesInVanta — partial-failure handling ───────────────────────

describe('clearDevicesInVanta — partial failure', () => {
  const opts = {
    macosResourceId: 'res-mac-123',
    windowsResourceId: 'res-win-123'
  };

  test('both succeed — cleared: true, both responses returned', async () => {
    const client = stubClient();
    const result = await clearDevicesInVanta({ ...opts, vantaClient: client });
    assert.strictEqual(result.cleared, true);
    assert.strictEqual(result.failures.macos, null);
    assert.strictEqual(result.failures.windows, null);
    // Both PUTs sent an empty resources array.
    assert.strictEqual(client.calls.length, 2);
    assert.deepStrictEqual(client.calls[0].body.resources, []);
    assert.deepStrictEqual(client.calls[1].body.resources, []);
  });

  test('Windows fails after macOS cleared — throws with stats indicating partial', async () => {
    const client = stubClientFailing('/v1/resources/WindowsUserComputer', 'win clear failed');
    let thrown;
    try { await clearDevicesInVanta({ ...opts, vantaClient: client }); } catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.strictEqual(thrown.partial, true, 'macOS was already cleared');
    assert.strictEqual(thrown.stats.failures.macos, null);
    assert.match(thrown.stats.failures.windows, /win clear failed/);
    assert.strictEqual(client.calls.length, 2);
  });
});
