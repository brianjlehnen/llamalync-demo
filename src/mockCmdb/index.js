const express = require('express');
const path = require('path');
const fs = require('fs');
const { safeLoadJson } = require('../utils/safeLoadJson');
const { isBeforeOrMissing } = require('../utils/dateHelpers');

/**
 * Fake "CMDB-X" — stands in for a customer's homegrown / on-prem asset
 * inventory (ServiceNow CMDB, internal asset DB, on-prem MDM, etc.) that
 * Vanta has no native connector for. Holds an in-memory mutation layer over
 * the baseline JSON file so the dashboard can demonstrate live Onboard,
 * Decommission, and Reassign-Owner flows without touching the source file.
 *
 * Mutations reset on server restart by design — demo prop, not persistent.
 *
 * Promotion path: when LlamaLync deploys, /mock-cmdbx deploys with it. For
 * a real customer integration, swap loadDevices() to fetch from the customer's
 * CMDB API (ServiceNow Table API, internal asset-DB endpoint, MDM webhook).
 *
 * Architectural note: unlike Risk (Manage Vanta write), CMDB-X devices push
 * via the Build Integrations surface — same family as Personnel. The
 * twist relative to Personnel is that Vanta exposes TWO separate computer
 * resource types (MacosUserComputer + WindowsUserComputer) with distinct
 * schemas, and Linux has no native base resource — Linux source rows are
 * deliberately surfaced as "unsupported source row" in the dashboard and
 * excluded from any PUT. See docs/scenarios/devices.md for the full design.
 */
const router = express.Router();
const DEVICES_FILE = path.join(__dirname, '../../mock-data/devices.json');

// Pool of plausible new device records. Cycled through on each Onboard click.
// Mixed OS so the demo can show a new macOS, Windows, and Linux record arriving.
const NEW_DEVICE_POOL = [
  {
    os: 'macOS',
    osVersion: '14.2.1',
    hostnameTemplate: 'mac-new',
    isXProtectEnabled: true,
    isManaged: true,
    autoUpdatesEnabled: true,
    applications: [
      { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', lastOpenedAt: null },
      { name: '1Password', bundleId: 'com.1password.1password', lastOpenedAt: null }
    ],
    drives: [{ name: 'Macintosh HD', encrypted: true, filevaultEnabled: true, isBootVolume: true }]
  },
  {
    os: 'Windows',
    osVersion: '11.23H2',
    hostnameTemplate: 'win-new',
    isManaged: true,
    autoUpdatesEnabled: true,
    programs: [
      { name: 'Microsoft Teams', lastOpenedAt: null },
      { name: 'Microsoft Edge', lastOpenedAt: null }
    ],
    drives: [{ name: 'C:', encrypted: true, isBootVolume: true }],
    windowsSecurityCenter: {
      firewall: 'GOOD', autoupdate: 'GOOD', antivirus: 'GOOD',
      internetSetting: 'GOOD', userAccountControl: 'GOOD',
      windowsSecurityCenterService: 'GOOD'
    },
    windowsSecurityProducts: [
      {
        name: 'Microsoft Defender',
        category: 'ANTIVIRUS',
        state: 'ON',
        stateTimestamp: new Date().toISOString(),
        signaturesUpToDate: true
      }
    ]
  },
  {
    // Linux is intentionally included in the pool so the dashboard can demo
    // a new Linux device arriving and immediately being flagged as
    // "unsupported source row" in the source/Vanta side-by-side.
    os: 'Linux',
    osVersion: 'Ubuntu 24.04 LTS',
    hostnameTemplate: 'linux-new',
    isManaged: false,
    autoUpdatesEnabled: true,
    drives: [{ name: '/dev/sda1', encrypted: true, isBootVolume: true }]
  }
];

// Mutation state — lives only in memory, resets on restart.
let mutations = {
  added: [],          // brand-new devices beyond the file
  statusChanges: {},  // { 'DEV-XXX': { status: 'decommissioned', decommissionedAt: 'YYYY-MM-DD' } }
  ownerChanges: {},   // { 'DEV-XXX': { assignedEmployeeId: 'emp-XXX' } }
  onboardCounter: 0   // monotonic counter for unique IDs across the demo session
};

function loadDevices() {
  const stat = fs.statSync(DEVICES_FILE);
  const baseline = safeLoadJson(DEVICES_FILE);

  // Apply status changes first, then owner changes — order is incidental
  // since they touch different fields, but mirrors mockHris's overlay style.
  const applyChanges = (d) => {
    let out = d;
    const statusChange = mutations.statusChanges[d.id];
    if (statusChange) out = { ...out, ...statusChange };
    const ownerChange = mutations.ownerChanges[d.id];
    if (ownerChange) out = { ...out, ...ownerChange };
    return out;
  };

  const data = [...baseline.map(applyChanges), ...mutations.added.map(applyChanges)];
  return { data, lastModified: stat.mtime.toISOString(), mutationCount: countMutations() };
}

function countMutations() {
  return mutations.added.length
       + Object.keys(mutations.statusChanges).length
       + Object.keys(mutations.ownerChanges).length;
}

function onboard() {
  const idx = mutations.onboardCounter % NEW_DEVICE_POOL.length;
  const cycle = Math.floor(mutations.onboardCounter / NEW_DEVICE_POOL.length);
  mutations.onboardCounter++;

  const template = NEW_DEVICE_POOL[idx];
  const id = `DEV-NEW-${String(mutations.onboardCounter).padStart(3, '0')}`;
  const hostname = `${template.hostnameTemplate}-${String(mutations.onboardCounter).padStart(3, '0')}`;
  const nowIso = new Date().toISOString();

  // Minimal common scaffold; per-OS template fields are spread in last so
  // they override / add fields specific to the platform.
  const device = {
    id,
    hostname,
    serialNumber: `NEW-${id}`,
    os: template.os,
    osVersion: template.osVersion,
    hardwareUuid: `NEW-${id}-${cycle}`,
    assignedEmployeeId: null,
    lastSeen: nowIso,
    status: 'active',
    isManaged: template.isManaged,
    autoUpdatesEnabled: template.autoUpdatesEnabled,
    browserExtensions: [],
    users: [],
    systemScreenlockPolicies: [],
    drives: template.drives ? template.drives.map(d => ({ ...d })) : []
  };
  // Per-OS payload fields
  if (template.applications)             device.applications = template.applications.map(a => ({ ...a }));
  if (template.programs)                 device.programs = template.programs.map(p => ({ ...p }));
  if (template.isXProtectEnabled != null) device.isXProtectEnabled = template.isXProtectEnabled;
  if (template.windowsSecurityCenter)    device.windowsSecurityCenter = { ...template.windowsSecurityCenter };
  if (template.windowsSecurityProducts)  device.windowsSecurityProducts = template.windowsSecurityProducts.map(p => ({ ...p }));

  mutations.added.push(device);
  return device;
}

function decommission(id) {
  const { data } = loadDevices();
  const device = data.find(d => d.id === id);
  if (!device) return { ok: false, status: 404, error: 'Device not found' };
  if (device.status === 'decommissioned') {
    return { ok: false, status: 409, error: 'Already decommissioned' };
  }

  // Decommission semantics: the device drops out of the active set used for
  // the Vanta PUT. The CMDB-X record still exists in the source listing (for
  // audit / historical reference) but `status === 'decommissioned'`.
  mutations.statusChanges[id] = {
    status: 'decommissioned',
    decommissionedAt: new Date().toISOString().split('T')[0]
  };
  return { ok: true, device: { id, ...mutations.statusChanges[id] } };
}

function reassignOwner(id, newAssignedEmployeeId) {
  const { data } = loadDevices();
  const device = data.find(d => d.id === id);
  if (!device) return { ok: false, status: 404, error: 'Device not found' };
  if (device.status === 'decommissioned') {
    return { ok: false, status: 409, error: 'Decommissioned devices cannot be reassigned' };
  }
  // null is a valid reassignment (explicitly orphaning a device).
  mutations.ownerChanges[id] = { assignedEmployeeId: newAssignedEmployeeId ?? null };
  return { ok: true, device: { id, ...mutations.ownerChanges[id] } };
}

function resetMutations() {
  mutations = { added: [], statusChanges: {}, ownerChanges: {}, onboardCounter: 0 };
}

// ─── Routes ────────────────────────────────────────────────────────────────

router.get('/mock-cmdbx/devices.json', (req, res) => {
  const { data } = loadDevices();
  res.json(data);
});

router.get('/mock-cmdbx/_meta.json', (req, res) => {
  const { data, lastModified, mutationCount } = loadDevices();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Compliance-shaped breakdown — surfaces the gaps that the demo highlights:
  // orphans, unencrypted drives, stale check-ins, unmanaged endpoints, and
  // Linux devices (which Vanta does not natively support; they are
  // deliberately surfaced as "unsupported source rows" rather than silently
  // dropped — strongest SA demo moment per the GAP 1 plan amendment).
  const active = data.filter(d => d.status === 'active');
  res.json({
    source: 'CMDB-X — simulated homegrown asset inventory',
    served: 'GET /mock-cmdbx/devices.json',
    sourceFile: 'mock-data/devices.json',
    lastModified,
    sessionMutations: mutationCount,
    totalRecords: data.length,
    breakdown: {
      active: active.length,
      decommissioned: data.filter(d => d.status === 'decommissioned').length,
      byOs: {
        macOS:   active.filter(d => d.os === 'macOS').length,
        Windows: active.filter(d => d.os === 'Windows').length,
        Linux:   active.filter(d => d.os === 'Linux').length
      },
      orphans:     active.filter(d => !d.assignedEmployeeId).length,
      unmanaged:   active.filter(d => d.isManaged === false).length,
      unencrypted: active.filter(d => (d.drives || []).some(dr => dr.encrypted === false)).length,
      // Missing/invalid `lastSeen` is treated as stale — a device the CMDB
      // can't tell us about IS stale by any reasonable definition.
      staleCheckIn30d: active.filter(d => isBeforeOrMissing(d.lastSeen, thirtyDaysAgo)).length,
      // Linux subtotal is repeated here for emphasis: this number is the
      // "unsupported source row" count surfaced in the dashboard.
      unsupportedNativeResource: active.filter(d => d.os === 'Linux').length
    }
  });
});

// JSON body parsing for the mutation routes (the global parser is registered
// AFTER the routers in index.js to avoid breaking the webhook raw body path).
router.use(express.json());

router.post('/mock-cmdbx/devices', (req, res) => {
  const device = onboard();
  res.status(201).json(device);
});

router.post('/mock-cmdbx/devices/:id/decommission', (req, res) => {
  const result = decommission(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.device);
});

router.post('/mock-cmdbx/devices/:id/reassign', (req, res) => {
  // Body shape: { assignedEmployeeId: 'emp-XXX' | null }
  const newAssignedEmployeeId = (req.body && 'assignedEmployeeId' in req.body)
    ? req.body.assignedEmployeeId
    : null;
  const result = reassignOwner(req.params.id, newAssignedEmployeeId);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.device);
});

router.post('/mock-cmdbx/reset', (req, res) => {
  resetMutations();
  res.json({ ok: true });
});

module.exports = {
  router,
  loadDevices,
  // Exposed for tests
  _onboard: onboard,
  _decommission: decommission,
  _reassignOwner: reassignOwner,
  _resetMutations: resetMutations
};
