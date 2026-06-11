const path = require('path');
const { buildClient } = require('../../http/vantaClient');
const { loadDevices: defaultLoadDevices } = require('../../mockCmdb');
const { loadEmployees: defaultLoadEmployees } = require('../../mockHris');
const logger = require('../../utils/logger');

// Vanta's Build Integrations sync endpoints for the two platform-specific
// computer resource types. PUT semantics are full-snapshot (same as
// user_account): anything not in `resources` is marked deleted.
//
// Path naming is exact-case, NOT snake_case (verified Phase 0 — see
// docs/build-log.md "Computer resources — what's different"). Linux has
// no native base resource type; Linux source rows are surfaced in the
// dashboard as "unsupported source row" and excluded from any PUT, per
// the approved GAP 1 plan amendment.
const MACOS_PATH   = '/v1/resources/MacosUserComputer';
const WINDOWS_PATH = '/v1/resources/WindowsUserComputer';

/**
 * Resolve a device's assignedEmployeeId to a Vanta-facing owner email by
 * looking up the People-X employee roster. Three outcomes:
 *
 *   - assignedEmployeeId is null/undefined            → owner = null (orphan)
 *   - assignedEmployeeId is set but not in roster     → owner = null (unknown
 *     source-side id; warn-worthy but not a hard fail because the resource
 *     type's `owner` field is optional + nullable per the schema)
 *   - assignedEmployeeId is set and resolves          → owner = email
 *
 * The `owner` field in both MacosUserComputer and WindowsUserComputer is
 * type string + nullable (per Phase 0 schema). Vanta validates the email
 * against the People entity at write time — same shape as risk-scenarios
 * `owner` per the risk slice-4.5 probe finding. Unknown-owner devices push
 * with `owner: null` rather than risking a 422.
 */
function resolveOwnerEmail(device, emailById) {
  if (!device.assignedEmployeeId) return null;
  return emailById.get(device.assignedEmployeeId) ?? null;
}

/**
 * Common required + optional fields shared by macOS and Windows transforms.
 * Per-platform transforms add osName, the app/program inventory under its
 * platform-specific key, drives (with filevault on macOS only), and
 * platform-specific optional fields (isXProtectEnabled / windowsSecurity*).
 */
function commonComputerFields(device, emailById) {
  return {
    displayName:           device.hostname,
    uniqueId:              device.id,
    externalUrl:           `https://cmdbx.example.com/devices/${device.id}`,
    collectedTimestamp:    device.lastSeen,
    osVersion:             device.osVersion,
    hardwareUuid:          device.hardwareUuid,
    serialNumber:          device.serialNumber,
    browserExtensions: (device.browserExtensions || []).map(e => ({
      extensionId: e.extensionId,
      name:        e.name,
      browser:     e.browser
    })),
    users: (device.users || []).map(u => ({
      username:           u.username,
      screenlockPolicies: u.screenlockPolicies || [],
      screenlockSettings: u.screenlockSettings || { requiresPassword: false, screenSleepTimeoutMs: 0 },
      // Optional inside `users[]` items — only include when present, since
      // an empty/null lastLogin shouldn't masquerade as a real one.
      ...(u.lastLoginAt ? { lastLoginTimestamp: u.lastLoginAt } : {})
    })),
    systemScreenlockPolicies: device.systemScreenlockPolicies || [],
    isManaged:                !!device.isManaged,
    autoUpdatesEnabled:       !!device.autoUpdatesEnabled,
    // NOTE on customProperties: the Dev Console JTD schema lists this under
    // `properties` (= required, per JTD), but Vanta's runtime validator
    // REJECTS it as "Extra keys: customProperties" (smoke test 2026-05-14).
    // Same lenient/wrong-direction behavior the existing personnel sync
    // ran into — personnelSync.js also omits customProperties and works.
    // The Console-declared schema and the validated schema diverge for
    // this field; trust the validator. Documented in docs/build-log.md.
    // Optional shared fields — emit explicit null when absent so the payload
    // shape is stable and snapshot tests don't churn on missing-vs-null.
    owner:                    resolveOwnerEmail(device, emailById),
    passwordPolicy:           device.passwordPolicy ?? null,
    lastEnrolledTimestamp:    device.lastEnrolledAt ?? null
  };
}

/**
 * Transform a CMDB-X source row into a Vanta `MacosUserComputer` payload.
 * macOS-specific: `applications` (with required bundleId per item),
 * `drives` with `filevaultEnabled`, optional `isXProtectEnabled`.
 */
function transformMacosDevice(device, { emailById } = { emailById: new Map() }) {
  return {
    ...commonComputerFields(device, emailById),
    osName: 'macOS',
    applications: (device.applications || []).map(a => ({
      name:     a.name,
      bundleId: a.bundleId,
      ...(a.lastOpenedAt ? { lastOpenedTimestamp: a.lastOpenedAt } : {})
    })),
    drives: (device.drives || []).map(d => ({
      name:             d.name,
      encrypted:        !!d.encrypted,
      filevaultEnabled: !!d.filevaultEnabled,
      ...(d.isBootVolume != null ? { isBootVolume: d.isBootVolume } : {})
    })),
    isXProtectEnabled: device.isXProtectEnabled ?? null
  };
}

/**
 * Transform a CMDB-X source row into a Vanta `WindowsUserComputer` payload.
 * Windows-specific: `programs` (only `name` required per item — no bundleId),
 * `drives` WITHOUT `filevaultEnabled`, optional `windowsSecurityProducts[]`
 * and `windowsSecurityCenter` (six independent enum-rated signals).
 */
function transformWindowsDevice(device, { emailById } = { emailById: new Map() }) {
  return {
    ...commonComputerFields(device, emailById),
    osName: 'Windows',
    programs: (device.programs || []).map(p => ({
      name: p.name,
      ...(p.lastOpenedAt ? { lastOpenedTimestamp: p.lastOpenedAt } : {})
    })),
    drives: (device.drives || []).map(d => ({
      name:      d.name,
      encrypted: !!d.encrypted,
      ...(d.isBootVolume != null ? { isBootVolume: d.isBootVolume } : {})
    })),
    windowsSecurityProducts: device.windowsSecurityProducts || null,
    windowsSecurityCenter:   device.windowsSecurityCenter   || null
  };
}

/**
 * Bucket CMDB-X devices by sync disposition. Pure function — no I/O.
 *
 *   - macos          → pushed via MacosUserComputer PUT
 *   - windows        → pushed via WindowsUserComputer PUT
 *   - linuxUnsupported → surfaced in the dashboard as "unsupported source
 *     row", excluded from any PUT (no native Vanta base type for Linux)
 *   - decommissioned → excluded entirely; drop out of the next full-snapshot
 *     PUT and Vanta soft-deletes via PUT semantics
 *
 * Exposed for tests so the platform-split logic can be verified without
 * touching the Vanta client.
 */
function bucketDevices(devices) {
  const active           = devices.filter(d => d.status !== 'decommissioned');
  const macos            = active.filter(d => d.os === 'macOS');
  const windows          = active.filter(d => d.os === 'Windows');
  const linuxUnsupported = active.filter(d => d.os === 'Linux');
  const decommissioned   = devices.filter(d => d.status === 'decommissioned');
  return { macos, windows, linuxUnsupported, decommissioned };
}

/**
 * Push one platform's full-snapshot. Wraps the PUT in try/catch and returns
 * a structured result so the caller can distinguish per-platform success
 * from failure. Independent of the other platform — the two PUTs target
 * separate Vanta resources and either can succeed while the other fails.
 */
async function pushPlatform({ vantaClient, path, resourceId, platform, payload }) {
  logger.info(`Pushing ${platform} computer snapshot to Vanta`, {
    count: payload.length,
    resourceId
  });
  try {
    const response = await vantaClient.put(path, { resourceId, resources: payload });
    return { ok: true, attempted: payload.length, pushed: payload.length, response, error: null };
  } catch (err) {
    logger.error(`Failed to push ${platform} computer snapshot to Vanta`, {
      error: err.message,
      attempted: payload.length,
      resourceId
    });
    return { ok: false, attempted: payload.length, pushed: 0, response: null, error: err.message };
  }
}

/**
 * Run the full CMDB-X → Vanta computer sync.
 *
 *   1. Load CMDB-X source via loadDevices()
 *   2. Load People-X roster to build an emp-id → email map for owner lookup
 *   3. Bucket devices: macos / windows / linuxUnsupported / decommissioned
 *   4. PUT MacosUserComputer  (full snapshot of macOS active devices)
 *   5. PUT WindowsUserComputer (full snapshot of Windows active devices)
 *   6. Return stats including the linuxUnsupported list for dashboard surfacing
 *
 * Partial-failure handling: macOS and Windows target independent Vanta
 * resources. The prior code awaited each PUT in sequence without try/catch,
 * so a Windows failure after a successful macOS PUT rejected the whole
 * function — the caller had no signal that macOS had already mutated Vanta.
 * Now each PUT is wrapped, both are always attempted, and the result
 * captures per-platform success/failure. On any failure the function still
 * throws (preserving the existing route contract) but attaches the full
 * stats object to err.stats so callers can surface "macOS pushed N,
 * Windows failed: <msg>" instead of an opaque "device sync failed".
 *
 * Dependency injection mirrors `runRiskSync` — tests stub loadDevices,
 * loadEmployees, vantaClient, and the two resource-id env vars.
 */
async function runDeviceSync({
  allowEmpty        = false,
  loadDevices       = defaultLoadDevices,
  loadEmployees     = defaultLoadEmployees,
  vantaClient       = buildClient,
  macosResourceId   = process.env.VANTA_MACOS_RESOURCE_ID,
  windowsResourceId = process.env.VANTA_WINDOWS_RESOURCE_ID
} = {}) {
  if (!macosResourceId) {
    throw new Error(
      'VANTA_MACOS_RESOURCE_ID must be set. Declare a MacosUserComputer Resource ' +
      'in Vanta Developer Console (Build Integrations app → Resources tab → ' +
      'base type "MacosUserComputer") and set the env var to its Resource ID. ' +
      'See docs/scenarios/devices.md for the setup steps.'
    );
  }
  if (!windowsResourceId) {
    throw new Error(
      'VANTA_WINDOWS_RESOURCE_ID must be set. Declare a WindowsUserComputer ' +
      'Resource in Vanta Developer Console alongside the macOS one and set ' +
      'the env var to its Resource ID. See docs/scenarios/devices.md.'
    );
  }

  logger.info('Starting device sync...');

  // Read through mockCmdb / mockHris so in-memory mutations (Onboard /
  // Decommission / Reassign / Hire / Offboard) flow through to Vanta on the
  // next sync — same pattern as the personnel sync.
  const { data: devices } = loadDevices();
  const { data: employees } = loadEmployees();
  const emailById = new Map(employees.map(e => [e.id, e.email]));

  const { macos, windows, linuxUnsupported, decommissioned } = bucketDevices(devices);

  // Full-snapshot PUT semantics mean an empty payload on EITHER platform PUT
  // soft-deletes every device Vanta currently holds for that resource. A
  // legitimately Windows-less customer would push macOS-only every run — so
  // we deliberately don't guard each platform independently. The scary case
  // is the SOURCE going silent: zero active macOS + zero active Windows +
  // zero unsupported Linux. That's a CMDB fetch blip, a mid-edit JSON file,
  // or every device filtered out — never a customer's actual fleet shape.
  // Refuse it unless the caller opts in with `allowEmpty: true` (currently
  // only `clearDevicesInVanta` would, and it bypasses runDeviceSync entirely).
  const activeCount = macos.length + windows.length + linuxUnsupported.length;
  if (activeCount === 0 && !allowEmpty) {
    throw new Error(
      'Refusing to PUT empty device snapshot without allowEmpty=true. ' +
      'CMDB-X returned zero active devices (macOS + Windows + Linux). ' +
      'Inspect mock-data/devices.json or restart the source to recover.'
    );
  }

  const macosPayload   = macos.map(d => transformMacosDevice(d, { emailById }));
  const windowsPayload = windows.map(d => transformWindowsDevice(d, { emailById }));

  const macosOrphans   = macosPayload.filter(p => !p.owner).length;
  const windowsOrphans = windowsPayload.filter(p => !p.owner).length;

  // Run both PUTs sequentially. We deliberately attempt the Windows PUT even
  // if macOS failed — they target independent resources and the caller wants
  // both outcomes captured for accurate triage.
  const macosResult = await pushPlatform({
    vantaClient, path: MACOS_PATH, resourceId: macosResourceId,
    platform: 'macOS', payload: macosPayload
  });
  const windowsResult = await pushPlatform({
    vantaClient, path: WINDOWS_PATH, resourceId: windowsResourceId,
    platform: 'Windows', payload: windowsPayload
  });

  const stats = {
    pushed: {
      macos:   macosResult.pushed,
      windows: windowsResult.pushed
    },
    attempted: {
      macos:   macosResult.attempted,
      windows: windowsResult.attempted
    },
    failures: {
      macos:   macosResult.error,
      windows: windowsResult.error
    },
    orphans: {
      macos:   macosOrphans,
      windows: windowsOrphans
    },
    skipped: {
      linuxUnsupported: linuxUnsupported.length,
      decommissioned:   decommissioned.length
    },
    // Surface the actual Linux rows for the dashboard — these become the
    // "unsupported source row" entries with a tooltip explaining the gap.
    unsupportedLinuxRows: linuxUnsupported.map(d => ({
      id:                 d.id,
      hostname:           d.hostname,
      assignedEmployeeId: d.assignedEmployeeId
    })),
    responses: {
      macos:   macosResult.response,
      windows: windowsResult.response
    }
  };

  const failedPlatforms = [];
  if (!macosResult.ok)   failedPlatforms.push('macOS');
  if (!windowsResult.ok) failedPlatforms.push('Windows');

  if (failedPlatforms.length > 0) {
    logger.warn('Device sync partially failed', {
      failed:  failedPlatforms,
      pushed:  stats.pushed,
      failures: stats.failures
    });
    const err = new Error(
      `Device sync failed on ${failedPlatforms.join(' + ')}. ` +
      `macOS: ${macosResult.ok ? `pushed ${macosResult.pushed}` : macosResult.error}. ` +
      `Windows: ${windowsResult.ok ? `pushed ${windowsResult.pushed}` : windowsResult.error}.`
    );
    err.partial = macosResult.ok || windowsResult.ok;
    err.stats = stats;
    throw err;
  }

  logger.info('Device sync complete', {
    pushed:           stats.pushed,
    orphans:          stats.orphans,
    skipped:          stats.skipped,
    unsupportedCount: stats.unsupportedLinuxRows.length
  });

  return stats;
}

/**
 * Push two empty computer snapshots (MacosUserComputer + WindowsUserComputer)
 * to Vanta. Used by the dashboard's "Reset demo state" workflow — full-snapshot
 * PUT semantics mean each empty `resources: []` array soft-deletes every
 * device Vanta holds for that resource id. Two calls because the two platforms
 * are separate resources. Linux has no Vanta-side records to clear.
 *
 * Returns the per-platform response so the UI can report success on both.
 */
async function clearDevicesInVanta({
  vantaClient       = buildClient,
  macosResourceId   = process.env.VANTA_MACOS_RESOURCE_ID,
  windowsResourceId = process.env.VANTA_WINDOWS_RESOURCE_ID
} = {}) {
  if (!macosResourceId)   throw new Error('VANTA_MACOS_RESOURCE_ID must be set');
  if (!windowsResourceId) throw new Error('VANTA_WINDOWS_RESOURCE_ID must be set');

  logger.info('Clearing computer snapshots in Vanta (empty PUTs)', {
    macosResourceId, windowsResourceId
  });

  // Same partial-failure handling as runDeviceSync: each platform is an
  // independent resource, so a Windows clear failure after a successful
  // macOS clear must not erase the fact that macOS was already wiped.
  const macosResult = await pushPlatform({
    vantaClient, path: MACOS_PATH, resourceId: macosResourceId,
    platform: 'macOS', payload: []
  });
  const windowsResult = await pushPlatform({
    vantaClient, path: WINDOWS_PATH, resourceId: windowsResourceId,
    platform: 'Windows', payload: []
  });

  const result = {
    cleared: macosResult.ok && windowsResult.ok,
    failures: {
      macos:   macosResult.error,
      windows: windowsResult.error
    },
    responses: {
      macos:   macosResult.response,
      windows: windowsResult.response
    }
  };

  if (!macosResult.ok || !windowsResult.ok) {
    const failed = [];
    if (!macosResult.ok)   failed.push('macOS');
    if (!windowsResult.ok) failed.push('Windows');
    logger.warn('Device clear partially failed', { failed, failures: result.failures });
    const err = new Error(
      `Device clear failed on ${failed.join(' + ')}. ` +
      `macOS: ${macosResult.ok ? 'cleared' : macosResult.error}. ` +
      `Windows: ${windowsResult.ok ? 'cleared' : windowsResult.error}.`
    );
    err.partial = macosResult.ok || windowsResult.ok;
    err.stats = result;
    throw err;
  }

  logger.info('Computer snapshots cleared in Vanta');
  return result;
}

// Allow running directly: node src/sync/jobs/deviceSync.js
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
  runDeviceSync().catch(err => {
    logger.error('Device sync failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = {
  runDeviceSync,
  clearDevicesInVanta,
  transformMacosDevice,
  transformWindowsDevice,
  bucketDevices,
  resolveOwnerEmail
};
