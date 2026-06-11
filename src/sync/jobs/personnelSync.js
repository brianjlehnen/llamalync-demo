const path = require('path');
const { buildClient } = require('../../http/vantaClient');
const { loadEmployees } = require('../../mockHris');
const logger = require('../../utils/logger');

// Vanta's Build Integrations sync endpoint for the user_account resource type.
// PUT semantics are full-snapshot: anything not in `resources` is marked deleted.
// That's why we batch every active record into one call instead of looping.
const USER_ACCOUNT_PATH = '/v1/resources/user_account';

/**
 * Convert a date-like value to an ISO-8601 string, returning null on
 * missing or unparseable input. The prior code called
 * `new Date(emp.startDate).toISOString()` directly — `new Date(undefined)`
 * yields an Invalid Date and `toISOString()` throws RangeError, so a single
 * employee row with a missing startDate would abort the entire snapshot
 * transform via the surrounding `.map()`.
 *
 * Returns null on bad input + logs a warn with the row id so the operator
 * notices the malformed record without losing the whole sync.
 */
function safeIsoFromDate(value, { context } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    logger.warn('Invalid date encountered; using null', { value, ...context });
    return null;
  }
  return d.toISOString();
}

/**
 * Transforms an internal employee record into a Vanta user_account payload.
 *
 * Vanta's `user_account` schema is identity/auth-shaped: it models "this human
 * has a login on this system" — not HR employment. So jobTitle/department/
 * employmentStatus belong on a separate resource (the Vanta-side People entity
 * via Manage Vanta), not here. Mock data lacks IAM signals, so MFA / login /
 * auth fields are stubbed with reasonable defaults a real HRIS-IAM integration
 * would provide from the source system.
 */
function transformEmployee(emp) {
  const fullName = `${emp.firstName} ${emp.lastName}`;

  // Phase 2 finding (2026-05-14): there is no API path for HR-shaped data
  // into Vanta. Three writable surfaces all reject HR fields:
  //   1. PATCH /v1/people/{id} — rejects jobTitle / department / etc.
  //      as "excess property" (2026-05-13 People probe).
  //   2. user_account top-level fields — rejects jobTitle / department /
  //      employmentStatus as extras (build-log.md "Schema discovery").
  //   3. user_account.customProperties — rejected at runtime with
  //      "Too many fields ... Extra keys: customProperties" despite the
  //      JTD declaring it required (Phase 2a smoke test 2026-05-14, same
  //      idiom as the Computer-resource validator).
  // Supported HR ingestion channels are native HRIS connectors (Workday,
  // BambooHR, Rippling, Gusto, etc.), SCIM, CSV upload, or manual UI
  // entry. Custom integrations are NOT in that list. The transform
  // deliberately omits HR fields — see docs/scenarios/personnel.md for
  // the customer-facing framing.
  return {
    uniqueId: emp.id,
    email: emp.email,
    displayName: fullName,
    fullName,
    accountName: emp.email.split('@')[0],
    externalUrl: `https://peoplex.example.com/hr/employees/${emp.id}`,
    permissionLevel: 'BASE',
    mfaEnabled: false,
    mfaMethods: [],
    status: 'ACTIVE',
    authMethod: 'PASSWORD',
    createdTimestamp: safeIsoFromDate(emp.startDate, { context: { empId: emp.id } }),
    // lastLoginTimestamp comes from the source IDP/IAM system, not the HRIS.
    // The prior code synthesized `new Date()` here, which fabricated a fresh
    // login on every sync — masked dormant accounts in any Vanta test that
    // uses this field. Read from the source record (lastLogin / lastLoginAt
    // for forward-compatibility with two common shapes); null if the source
    // doesn't carry login signal yet.
    lastLoginTimestamp: safeIsoFromDate(
      emp.lastLogin ?? emp.lastLoginAt,
      { context: { empId: emp.id, field: 'lastLogin' } }
    )
  };
}

// Single source of truth for "what would LlamaLync push right now."
// Both runPersonnelSync (the PUT path) and driftCheck (the read-back diff)
// call through this so the two can never disagree about which source records
// count as syncable.
//
// Dedupes by emp.id (= Vanta uniqueId). Vanta's user_account schema rejects
// duplicate uniqueIds in a snapshot — better to drop dups locally with a
// warn (preserving the first occurrence) than to 422 the entire push and
// lose the snapshot for the sake of a data-quality error in the source.
function buildPersonnelResources(employees) {
  const active = employees.filter(e => !e.isServiceAccount && e.status === 'active');
  const byId = new Map();
  for (const emp of active) {
    if (byId.has(emp.id)) {
      logger.warn('Duplicate employee id in source; dropping later occurrence', {
        id: emp.id,
        kept:    { email: byId.get(emp.id).email },
        dropped: { email: emp.email }
      });
      continue;
    }
    byId.set(emp.id, emp);
  }
  return Array.from(byId.values()).map(transformEmployee);
}

/**
 * Pushes the full active-employee snapshot into Vanta.
 *
 * Currently scoped to the active-employee path. Two related flows are gated
 * on the Manage Vanta credential split (planned next):
 *   - Offboarding terminated employees needs GET /v1/people (Manage Vanta scope).
 *   - Marking service accounts needs PUT /v1/people/:id (Manage Vanta scope).
 * Both raised 403 against the Build Integrations token, as expected.
 *
 * Safety: PUT semantics are full-snapshot, so an empty `resources` array
 * soft-deletes every record Vanta currently holds. A transient empty source
 * (mock-fs blip, mid-edit JSON, all employees filtered out) would silently
 * wipe Vanta on the next run. We refuse empty pushes unless the caller opts
 * in with `allowEmpty: true` — currently only `clearPersonnelInVanta` does.
 */
async function runPersonnelSync({
  allowEmpty = false,
  loadEmployees: loadEmployeesFn = loadEmployees,
  client = buildClient
} = {}) {
  logger.info('Starting personnel sync...');

  if (!process.env.VANTA_PERSONNEL_RESOURCE_ID) {
    throw new Error('VANTA_PERSONNEL_RESOURCE_ID must be set in .env');
  }

  // Read through mockHris so in-memory mutations (Hire / Offboard from the
  // dashboard) flow through to Vanta on the next sync.
  const { data: employees } = loadEmployeesFn();

  const resources = buildPersonnelResources(employees);
  const skipped = {
    terminated: employees.filter(e => e.status === 'terminated').length,
    serviceAccounts: employees.filter(e => e.isServiceAccount).length
  };

  if (resources.length === 0 && !allowEmpty) {
    throw new Error('Refusing to PUT empty personnel snapshot without allowEmpty=true');
  }

  logger.info('Pushing personnel snapshot to Vanta', {
    activeCount: resources.length,
    skipped,
    resourceId: process.env.VANTA_PERSONNEL_RESOURCE_ID
  });

  // Single PUT — full snapshot replaces whatever Vanta has on file.
  const response = await client.put(USER_ACCOUNT_PATH, {
    resourceId: process.env.VANTA_PERSONNEL_RESOURCE_ID,
    resources
  });

  logger.info('Personnel sync complete', {
    pushed: resources.length,
    skipped,
    vantaResponse: response
  });

  return { pushed: resources.length, skipped, response };
}

/**
 * Push an empty user_account snapshot to Vanta. Used by the dashboard's
 * "Reset demo state" workflow — full-snapshot PUT semantics mean an empty
 * `resources: []` array soft-deletes every record Vanta currently holds
 * for this resource id, restoring a clean baseline before the next demo.
 *
 * Same path, same auth, same shape as runPersonnelSync — just no records.
 * Returns the cleared count from the prior snapshot so the UI can report
 * "cleared N records" rather than a meaningless "ok".
 */
async function clearPersonnelInVanta({ client = buildClient } = {}) {
  if (!process.env.VANTA_PERSONNEL_RESOURCE_ID) {
    throw new Error('VANTA_PERSONNEL_RESOURCE_ID must be set in .env');
  }

  logger.info('Clearing personnel snapshot in Vanta (empty PUT)', {
    resourceId: process.env.VANTA_PERSONNEL_RESOURCE_ID
  });

  const response = await client.put(USER_ACCOUNT_PATH, {
    resourceId: process.env.VANTA_PERSONNEL_RESOURCE_ID,
    resources: []
  });

  logger.info('Personnel snapshot cleared in Vanta', { vantaResponse: response });

  return { cleared: true, response };
}

// Allow running directly: node src/sync/jobs/personnelSync.js
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
  runPersonnelSync().catch(err => {
    logger.error('Personnel sync failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = {
  runPersonnelSync,
  clearPersonnelInVanta,
  buildPersonnelResources,
  transformEmployee,
  safeIsoFromDate
};
