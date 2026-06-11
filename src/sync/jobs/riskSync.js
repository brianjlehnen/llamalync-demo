const path = require('path');
const { manageClient } = require('../../http/vantaClient');
const {
  loadRisks: defaultLoadRisks,
  diffAgainstVanta,
  RISK_CUSTOM_FIELDS
} = require('../../mockRiskRegister');
const logger = require('../../utils/logger');

// Vanta's risk-scenario surface. POST creates, PATCH /{id} updates.
// PATCH semantics here are full-payload (we send everything every sync) so
// Vanta carries the current source-of-truth state. See docs/scenarios/risk.md
// §5 talk-track-4 for the customer-facing "Risk-X is the SoR" framing.
const RISK_SCENARIOS_PATH = '/v1/risk-scenarios';
const PEOPLE_PATH = '/v1/people';

// Strict enums — Vanta rejects out-of-enum values for these fields.
const CIA_ENUM = new Set(['Confidentiality', 'Integrity', 'Availability']);
const TREATMENT_ENUM = new Set(['Mitigate', 'Transfer', 'Avoid', 'Accept']);

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function extractPersonEmails(person) {
  const candidates = [
    person.email,
    person.primaryEmail,
    person.workEmail,
    person.user?.email,
    person.vantaUser?.email
  ];
  return candidates.map(normalizeEmail).filter(Boolean);
}

async function preflightOwnerEmails(sourceRisks, vantaClient) {
  const desiredOwners = new Set(
    sourceRisks.map(r => normalizeEmail(r.ownerEmail)).filter(Boolean)
  );
  if (desiredOwners.size === 0) {
    return { knownOwnerEmails: new Set(), unknownOwnerEmails: [] };
  }

  try {
    const people = await vantaClient.fetchAllPages(PEOPLE_PATH);
    const knownOwnerEmails = new Set();
    for (const person of people) {
      for (const email of extractPersonEmails(person)) {
        knownOwnerEmails.add(email);
      }
    }

    const unknownOwnerEmails = [...desiredOwners].filter(email => !knownOwnerEmails.has(email));
    if (unknownOwnerEmails.length > 0) {
      logger.warn('Risk owners not found in Vanta people list; owner field will be omitted on create and cleared on update', {
        count: unknownOwnerEmails.length,
        ownerEmails: unknownOwnerEmails
      });
    }

    return { knownOwnerEmails, unknownOwnerEmails };
  } catch (err) {
    // Do not block the sync if the preflight read fails; the write API will
    // still return a semantic 422 if an owner is invalid. This keeps the demo
    // resilient while preserving the safer path when /v1/people is available.
    logger.warn('Risk owner preflight failed; passing owner emails through to Vanta', {
      error: err.message
    });
    return { knownOwnerEmails: null, unknownOwnerEmails: [] };
  }
}

/**
 * Transform a Risk-X source row into a Vanta risk-scenario payload.
 *
 * Untreated signal: `currentMitigations == null`. Per slice-3 review feedback,
 * we MUST use this — not residual presence — because the mock data and
 * addRisk() flow both leave residual === inherent for untreated rows, which
 * would make residual-presence a useless signal.
 *
 * Untreated handling differs between POST and PATCH (slice-4.5, probe-verified
 * 2026-05-12: Vanta PATCH preserves omitted fields):
 *   - POST untreated  → omit residualLikelihood / residualImpact / note
 *                       (nothing to clear; Vanta UI shows inherent-only)
 *   - PATCH untreated → send explicit null for each so stale residual values
 *                       from a prior treated state get cleared
 *
 * `riskRegister` is REQUIRED. The slice-4.5 live probe found Vanta returns
 * 422 "Invalid fields (riskRegister)" on POST/PATCH even in single-register
 * tenants — contradicting the public docs' "optional unless multi-register."
 *
 * @param {object}   risk            Risk-X source row
 * @param {object}   opts
 * @param {boolean}  opts.forCreate  true for POST (include `riskId`), false for PATCH
 * @param {string}   opts.riskRegister  Required — Vanta rejects writes without it
 * @param {Set|null} [opts.knownOwnerEmails]  Lowercase Vanta-user emails from preflight
 */
function transformRisk(risk, { forCreate, riskRegister, knownOwnerEmails = null } = {}) {
  if (!riskRegister) {
    throw new Error(
      'transformRisk requires a riskRegister option. Vanta /v1/risk-scenarios returns ' +
      '422 "Invalid fields (riskRegister)" without it (probe-verified 2026-05-12, ' +
      'see docs/scenarios/risk.md §8.3).'
    );
  }

  const isUntreated = risk.currentMitigations == null;

  // Strict CIA filter — drop anything outside the canonical triad.
  const ciaCategories = (risk.ciaImpact || []).filter(c => CIA_ENUM.has(c));

  // Custom-fields contract is frozen (docs/scenarios/risk.md §6). Never compute
  // labels from data; always use the constants from RISK_CUSTOM_FIELDS.
  const customFields = [
    { label: RISK_CUSTOM_FIELDS.SOURCE_ID,            value: risk.internalId },
    { label: RISK_CUSTOM_FIELDS.SOURCE_STATUS,        value: risk.status },
    { label: RISK_CUSTOM_FIELDS.SOURCE_LAST_REVIEWED, value: risk.lastReviewedAt }
  ];
  if (Array.isArray(risk.linkedControlIds) && risk.linkedControlIds.length > 0) {
    // Joined as a comma-separated string because Vanta's multi-select
    // custom-attribute type requires predefined options — control IDs
    // are open-ended (SOC2-CC6.1, ISO-A.9.4.3, etc.) so the attribute
    // is declared as a text field in Vanta UI. Live-finding 2026-05-13.
    customFields.push({
      label: RISK_CUSTOM_FIELDS.SOURCE_CONTROL_IDS,
      value: risk.linkedControlIds.join(', ')
    });
  }

  const payload = {
    description: `${risk.title}\n\n${risk.description}`,
    categories: risk.category ? [risk.category] : [],
    ciaCategories,
    likelihood: risk.inherent.likelihood,
    impact: risk.inherent.impact,
    treatment: TREATMENT_ENUM.has(risk.treatment) ? risk.treatment : 'Mitigate',
    customFields
  };

  // Owner email must resolve to a valid Vanta user. When preflight data is
  // available, avoid guaranteed 422s: omit unknown owners on create and clear
  // them on update so stale Vanta owners do not survive indefinitely.
  if (risk.ownerEmail) {
    const normalizedOwner = normalizeEmail(risk.ownerEmail);
    if (knownOwnerEmails === null || knownOwnerEmails.has(normalizedOwner)) {
      payload.owner = risk.ownerEmail;
    } else if (!forCreate) {
      payload.owner = null;
    }
  }

  // Residual + note routing — see slice-4.5 probe findings in the header comment.
  //   treated         → send residual scoring + mitigation note
  //   PATCH untreated → send explicit nulls to clear stale prior values
  //   POST  untreated → omit (nothing to clear yet)
  if (!isUntreated) {
    payload.residualLikelihood = risk.residual.likelihood;
    payload.residualImpact = risk.residual.impact;
    payload.note = risk.currentMitigations;
  } else if (!forCreate) {
    payload.residualLikelihood = null;
    payload.residualImpact = null;
    payload.note = null;
  }

  // riskId is only used on create — the slice-4.5 probe confirmed Vanta uses
  // this as the canonical addressable ID (PATCH /v1/risk-scenarios/{riskId}
  // works directly; no separate Mongo ID returned). On PATCH we target via the
  // path, not the body.
  if (forCreate) payload.riskId = risk.internalId;

  // riskRegister is required (validated at top); always included.
  payload.riskRegister = riskRegister;

  return payload;
}

/**
 * Run the full Risk-X → Vanta sync.
 *
 *   1. Load Risk-X source via loadRisks()
 *   2. List existing risk scenarios from Vanta (paginated)
 *   3. Diff: bucket source rows into toCreate / toUpdate / staleInVanta
 *   4. POST each toCreate, PATCH each toUpdate
 *   5. Log staleInVanta as warnings (no DELETE endpoint on this surface)
 *
 * Dependency injection: production paths use the defaults; tests pass stubs.
 * Mirrors the pattern in src/reconcile/userAccountReconcile.js.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.loadRisks]      Override for source-side loader
 * @param {object}   [opts.vantaClient]    Override for the HTTP client (must
 *                                          expose fetchAllPages, post, patch)
 * @param {string}  [opts.riskRegister]    Override for the env-driven register
 *                                          name. Defaults to env VANTA_RISK_REGISTER.
 */
async function runRiskSync({
  loadRisks = defaultLoadRisks,
  vantaClient = manageClient,
  riskRegister = process.env.VANTA_RISK_REGISTER
} = {}) {
  if (!riskRegister) {
    throw new Error(
      'VANTA_RISK_REGISTER must be set. Vanta /v1/risk-scenarios POST/PATCH both ' +
      'require riskRegister even in single-register tenants (probe-verified 2026-05-12). ' +
      'Set the env var to your register name (e.g. "Default") — see ' +
      'docs/scenarios/risk.md §8.3.'
    );
  }

  logger.info('Starting risk sync...');

  const { data: sourceRisks } = loadRisks();
  const ownerPreflight = await preflightOwnerEmails(sourceRisks, vantaClient);

  logger.info('Listing existing risk scenarios from Vanta', { path: RISK_SCENARIOS_PATH });
  const vantaRisks = await vantaClient.fetchAllPages(RISK_SCENARIOS_PATH);

  const { toCreate, toUpdate, staleInVanta } = diffAgainstVanta(sourceRisks, vantaRisks);

  logger.info('Risk diff complete', {
    sourceCount: sourceRisks.length,
    vantaCount: vantaRisks.length,
    toCreate: toCreate.length,
    toUpdate: toUpdate.length,
    staleInVanta: staleInVanta.length
  });

  const stats = {
    created: 0,
    updated: 0,
    errors: 0,
    staleInVanta: staleInVanta.length,
    unknownOwnerEmails: ownerPreflight.unknownOwnerEmails,
    errorDetails: []
  };

  for (const { source } of toCreate) {
    try {
      const payload = transformRisk(source, {
        forCreate: true,
        riskRegister,
        knownOwnerEmails: ownerPreflight.knownOwnerEmails
      });
      await vantaClient.post(RISK_SCENARIOS_PATH, payload);
      stats.created++;
      logger.debug('Created risk scenario', { riskId: source.internalId });
    } catch (err) {
      stats.errors++;
      stats.errorDetails.push({ op: 'create', riskId: source.internalId, error: err.message });
      logger.error('Failed to create risk scenario', { riskId: source.internalId, error: err.message });
    }
  }

  for (const { source, riskScenarioId } of toUpdate) {
    try {
      const payload = transformRisk(source, {
        forCreate: false,
        riskRegister,
        knownOwnerEmails: ownerPreflight.knownOwnerEmails
      });
      await vantaClient.patch(
        `${RISK_SCENARIOS_PATH}/${encodeURIComponent(riskScenarioId)}`,
        payload
      );
      stats.updated++;
      logger.debug('Updated risk scenario', {
        riskId: source.internalId,
        riskScenarioId
      });
    } catch (err) {
      stats.errors++;
      stats.errorDetails.push({
        op: 'update',
        riskId: source.internalId,
        riskScenarioId,
        error: err.message
      });
      logger.error('Failed to update risk scenario', {
        riskId: source.internalId,
        riskScenarioId,
        error: err.message
      });
    }
  }

  if (staleInVanta.length > 0) {
    logger.warn('Risks in Vanta with no corresponding source row (left in place)', {
      count: staleInVanta.length,
      riskIds: staleInVanta.map(v => v.riskId)
    });
  }

  logger.info('Risk sync complete', {
    created: stats.created,
    updated: stats.updated,
    errors: stats.errors,
    staleInVanta: stats.staleInVanta
  });

  return stats;
}

// Allow running directly: node src/sync/jobs/riskSync.js
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
  runRiskSync().catch(err => {
    logger.error('Risk sync failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = { runRiskSync, transformRisk };
