// Reconciliation pattern — instantiated for the user_account resource.
//
// Diffs an external source-of-truth against what Vanta currently holds and
// surfaces records that are missing/extra/changed. The same pattern applies
// to any resource where Vanta receives a full-snapshot push from an upstream
// system: SCIM endpoints, LDAP, MDM (computer resources), evidence-bucket
// document inventories, etc. Per-resource specifics live here (which fields
// to compare, which loader, which Vanta path); the pure compareDrift helper
// is reusable across resource types.
//
// Currently has no caller — the dashboard intentionally doesn't surface
// drift on a static-source demo because the diff would be theater rather
// than signal. Wire this when the source becomes a real polling endpoint
// (SCIM, LDAP, MDM, etc.) where source mutations happen out-of-band.
const { buildClient } = require('../http/vantaClient');
const { loadEmployees: defaultLoadEmployees } = require('../mockHris');
const { buildPersonnelResources } = require('../sync/jobs/personnelSync');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 60 * 1000;

// Cache the Vanta read only — never the computed drift. Caching the result
// would hide source mutations: a Hire/Offboard within the TTL window would
// keep reporting "clean" until the cache expired. Source data is in-memory
// and effectively free to re-evaluate; the rate-limited Vanta GET is the
// only thing worth caching. Per-process, no external store, intentional POC scope.
let cachedVantaActive = null;
let cachedVantaAt = 0;

const CHANGED_FIELDS = ['email', 'displayName'];

function compact(record) {
  return {
    uniqueId: record.uniqueId,
    email: record.email,
    displayName: record.displayName
  };
}

async function fetchVantaActiveDefault() {
  const resourceId = process.env.VANTA_PERSONNEL_RESOURCE_ID;
  if (!resourceId) {
    throw new Error('VANTA_PERSONNEL_RESOURCE_ID not set in .env');
  }
  const data = await buildClient.get(`/v1/resources/user_account?resourceId=${resourceId}`);
  const all = data.resources || [];
  // Mirrors getPushedPersonnel: deletedAt records fell out of a prior PUT
  // and shouldn't count as "still in Vanta" for drift.
  return all.filter(r => !r.deletedAt);
}

/**
 * Returns Vanta active records, hitting cache when fresh. On error with a
 * cached payload available, returns the cached records flagged stale rather
 * than throwing — a brief Vanta outage shouldn't drop the drift card mid-demo.
 */
async function readVantaWithCache(fetcher, ttlMs, now) {
  const t = now();
  if (cachedVantaActive !== null && t - cachedVantaAt < ttlMs) {
    return { records: cachedVantaActive, stale: false };
  }
  try {
    const records = await fetcher();
    cachedVantaActive = records;
    cachedVantaAt = t;
    return { records, stale: false };
  } catch (err) {
    if (cachedVantaActive !== null) {
      return { records: cachedVantaActive, stale: true, error: err.message };
    }
    throw err;
  }
}

/**
 * Pure diff over already-loaded data. Kept separate from I/O so callers can
 * recompute against fresh source while reusing cached Vanta records.
 */
function compareDrift({ sourceResources, vantaActive }) {
  const sourceById = new Map(sourceResources.map(r => [r.uniqueId, r]));
  const vantaById = new Map(vantaActive.map(r => [r.uniqueId, r]));

  const missing = [];
  const extra = [];
  const changed = [];

  for (const [id, src] of sourceById) {
    const v = vantaById.get(id);
    if (!v) {
      missing.push(compact(src));
      continue;
    }
    const diffs = [];
    for (const field of CHANGED_FIELDS) {
      if (src[field] !== v[field]) {
        diffs.push({ field, source: src[field], vanta: v[field] });
      }
    }
    if (diffs.length) {
      changed.push({
        uniqueId: id,
        email: src.email,
        displayName: src.displayName,
        diffs
      });
    }
  }

  for (const [id, v] of vantaById) {
    if (!sourceById.has(id)) {
      extra.push(compact(v));
    }
  }

  return {
    comparedAt: new Date().toISOString(),
    sourceActiveCount: sourceById.size,
    vantaActiveCount: vantaById.size,
    drift: { missing, extra, changed }
  };
}

/**
 * Compose source loading, Vanta read, and diff. Uncached — always fetches.
 * Used directly in tests; production paths go through getDriftCheck.
 */
async function computeDrift({
  loadEmployees = defaultLoadEmployees,
  fetchVantaResources = fetchVantaActiveDefault
} = {}) {
  const { data: employees } = loadEmployees();
  const sourceResources = buildPersonnelResources(employees);
  const vantaActive = await fetchVantaResources();
  return compareDrift({ sourceResources, vantaActive });
}

/**
 * Production entry point. Caches the Vanta read for ttlMs but recomputes the
 * source side every call so Hire/Offboard mutations are reflected immediately.
 *
 * - Within TTL: serve cached Vanta records, fresh source diff, no `stale` flag.
 * - Past TTL, fetch succeeds: refresh cache, fresh diff.
 * - Past TTL, fetch fails, cache exists: serve stale Vanta records with fresh
 *   source diff and { stale: true, error } flags.
 * - No cache + fetch fails: { error } only.
 */
async function getDriftCheck({
  loadEmployees,
  fetchVantaResources,
  ttlMs = CACHE_TTL_MS,
  now = Date.now
} = {}) {
  const fetcher = fetchVantaResources ?? fetchVantaActiveDefault;
  const loader = loadEmployees ?? defaultLoadEmployees;

  let vantaResult;
  try {
    vantaResult = await readVantaWithCache(fetcher, ttlMs, now);
  } catch (err) {
    logger.warn('Drift check failed', { error: err.message });
    return { error: err.message };
  }

  const { data: employees } = loader();
  const sourceResources = buildPersonnelResources(employees);
  const result = compareDrift({ sourceResources, vantaActive: vantaResult.records });

  if (vantaResult.stale) {
    return { ...result, stale: true, error: vantaResult.error };
  }
  return result;
}

function _resetCache() {
  cachedVantaActive = null;
  cachedVantaAt = 0;
}

module.exports = { computeDrift, getDriftCheck, _resetCache };
