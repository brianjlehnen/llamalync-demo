const express = require('express');
const path = require('path');
const fs = require('fs');
const { safeLoadJson } = require('../utils/safeLoadJson');
const { isBeforeOrMissing } = require('../utils/dateHelpers');

/**
 * Fake "Risk-X" register — stands in for a customer's homegrown risk register
 * that Vanta has no native connector for. Holds an in-memory mutation layer
 * over the baseline JSON file so the dashboard can demonstrate live Add Risk,
 * Apply Treatment, and Mark Closed flows without touching the source file.
 *
 * Mutations reset on server restart by design — demo prop, not persistent.
 *
 * Promotion path: when LlamaLync deploys, /mock-riskx deploys with it. For a
 * real customer integration, swap loadRisks() to fetch from the customer's
 * GRC tool, Confluence page, Airtable, or whatever holds their actual register.
 *
 * Architectural note: unlike Personnel (Build Integrations), Risk targets the
 * Manage Vanta API surface — POST/PATCH /v1/risk-scenarios. The diff helper
 * here mirrors the list-and-diff algorithm in docs/scenarios/risk.md §4.
 */
const router = express.Router();
const RISKS_FILE = path.join(__dirname, '../../mock-data/risks.json');

// Locked custom-field labels. Mirrors the contract in docs/scenarios/risk.md §6.
// Treat as a frozen enum — never compute these strings from data; never rename
// without coordinated tenant cleanup, since changes pollute every tenant we've
// ever synced into.
const RISK_CUSTOM_FIELDS = Object.freeze({
  SOURCE_ID:            'Source Risk-X ID',
  SOURCE_STATUS:        'Source Status',
  SOURCE_CONTROL_IDS:   'Source Control IDs',
  SOURCE_LAST_REVIEWED: 'Source Last Reviewed'
});

// Pool of plausible "new risks identified this month at the security
// committee." Cycled through on each Add-Risk click.
const NEW_RISK_POOL = [
  {
    title: 'AI inference prompt-injection on customer-facing assistant',
    description: 'Newly launched assistant feature passes user content into LLM prompts without dedicated input filtering.',
    category: 'Operations',
    ciaImpact: ['Confidentiality', 'Integrity'],
    inherent: { likelihood: 4, impact: 4 },
    treatment: 'Mitigate',
    ownerEmail: 'sec-lead@example.com',
    linkedControlIds: ['SOC2-CC7.1']
  },
  {
    title: 'Unapproved Slack channel sharing customer transcript snippets',
    description: 'Support team discovered to be pasting customer transcript fragments into a Slack channel without DLP coverage.',
    category: 'Privacy',
    ciaImpact: ['Confidentiality'],
    inherent: { likelihood: 4, impact: 3 },
    treatment: 'Mitigate',
    ownerEmail: 'privacy-lead@example.com',
    linkedControlIds: ['SOC2-P3.2']
  },
  {
    title: 'Stale OAuth refresh tokens issued before rotation policy',
    description: 'Refresh tokens minted before the 2025 rotation policy change have no expiry. Long tail of long-lived credentials in the wild.',
    category: 'Access Control',
    ciaImpact: ['Confidentiality'],
    inherent: { likelihood: 3, impact: 4 },
    treatment: 'Mitigate',
    ownerEmail: 'luis.vega@peoplex.example.com',
    linkedControlIds: ['SOC2-CC6.1']
  },
  {
    title: 'Insufficient runbook coverage for a single-AZ outage',
    description: 'Per-service failover runbooks assume region-loss; no specific guidance for a single-AZ-loss scenario where partial traffic survives.',
    category: 'Business Continuity',
    ciaImpact: ['Availability'],
    inherent: { likelihood: 2, impact: 4 },
    treatment: 'Mitigate',
    ownerEmail: 'infra-lead@example.com',
    linkedControlIds: ['SOC2-A1.3']
  }
];

// Mutation state — lives only in memory, resets on restart.
let mutations = {
  added: [],         // brand-new risks beyond the file
  changes: {},       // { internalId: { ...overlaid fields } }
  addCounter: 0      // monotonic counter for unique IDs across the demo session
};

function loadRisks() {
  const stat = fs.statSync(RISKS_FILE);
  const baseline = safeLoadJson(RISKS_FILE);

  const applyChanges = (r) => {
    const change = mutations.changes[r.internalId];
    return change ? { ...r, ...change } : r;
  };

  const data = [...baseline.map(applyChanges), ...mutations.added.map(applyChanges)];
  return { data, lastModified: stat.mtime.toISOString(), mutationCount: countMutations() };
}

function countMutations() {
  return mutations.added.length + Object.keys(mutations.changes).length;
}

function addRisk() {
  const idx = mutations.addCounter % NEW_RISK_POOL.length;
  const cycle = Math.floor(mutations.addCounter / NEW_RISK_POOL.length);
  mutations.addCounter++;

  const template = NEW_RISK_POOL[idx];
  const suffix = cycle > 0 ? `-${cycle + 1}` : '';
  const internalId = `RX-NEW-${String(mutations.addCounter).padStart(3, '0')}`;

  const risk = {
    internalId,
    title: template.title + suffix,
    description: template.description,
    category: template.category,
    ciaImpact: [...template.ciaImpact],
    // New risks land with inherent-only scoring — Apply Treatment promotes
    // them to residual scoring on a later click.
    inherent: { ...template.inherent },
    currentMitigations: null,
    residual: { ...template.inherent },
    treatment: template.treatment,
    ownerEmail: template.ownerEmail,
    status: 'Open',
    lastReviewedAt: new Date().toISOString().split('T')[0],
    linkedControlIds: [...template.linkedControlIds]
  };
  mutations.added.push(risk);
  return risk;
}

function applyTreatment(internalId) {
  const { data } = loadRisks();
  const risk = data.find(r => r.internalId === internalId);
  if (!risk) return { ok: false, status: 404, error: 'Risk not found' };
  if (risk.status === 'Closed') {
    return { ok: false, status: 409, error: 'Closed risks cannot be re-treated' };
  }

  // "Effective" treatment: drop residual scoring meaningfully below inherent.
  // Likelihood drops by 1-2; impact by 0-1 (impact is harder to reduce in
  // practice). Floor at 1.
  const residual = {
    likelihood: Math.max(1, risk.inherent.likelihood - 2),
    impact: Math.max(1, risk.inherent.impact - 1)
  };

  mutations.changes[internalId] = {
    ...(mutations.changes[internalId] || {}),
    residual,
    currentMitigations: risk.currentMitigations
      || 'Treatment applied via security-committee review. Compensating controls documented in attached committee minutes.',
    lastReviewedAt: new Date().toISOString().split('T')[0]
  };
  return { ok: true, risk: { internalId, ...mutations.changes[internalId] } };
}

function markClosed(internalId) {
  const { data } = loadRisks();
  const risk = data.find(r => r.internalId === internalId);
  if (!risk) return { ok: false, status: 404, error: 'Risk not found' };
  if (risk.status === 'Closed') {
    return { ok: false, status: 409, error: 'Already closed' };
  }

  const closedAt = new Date().toISOString().split('T')[0];
  mutations.changes[internalId] = {
    ...(mutations.changes[internalId] || {}),
    status: 'Closed',
    closedAt,
    lastReviewedAt: closedAt
  };
  return { ok: true, risk: { internalId, ...mutations.changes[internalId] } };
}

function resetMutations() {
  mutations = { added: [], changes: {}, addCounter: 0 };
}

/**
 * Diff Risk-X source rows against a snapshot of Vanta's risk-scenarios list.
 * Pure function — no I/O, no Vanta calls. The eventual sync job (Step 4)
 * will call this with the result of GET /v1/risk-scenarios and route the
 * three buckets to POST, PATCH, or no-op.
 *
 * Match key: source.internalId ↔ vanta.riskId (the custom ID we passed on
 * create). Slice-4.5 live probe (2026-05-12) confirmed Vanta uses this custom
 * riskId as the canonical addressable ID — PATCH /v1/risk-scenarios/{riskId}
 * works directly with no separate Mongo ID. The fallback chain below is kept
 * defensively in case Vanta's response shape changes; in practice `customId`
 * is what gets surfaced.
 *
 * @param {Array} sourceRows  Risk-X rows from loadRisks().data
 * @param {Array} vantaRows   Risk scenarios from GET /v1/risk-scenarios
 * @returns {{ toCreate: Array, toUpdate: Array, staleInVanta: Array }}
 */
function diffAgainstVanta(sourceRows, vantaRows) {
  const vantaByRiskId = new Map();
  for (const v of vantaRows) {
    const customId = v.riskId;
    if (customId) {
      // Slice-4.5 probe confirmed custom riskId works directly in PATCH
      // paths. Keep alternate fields defensively in case Vanta's read shape
      // changes, but the normal production path surfaces customId.
      vantaByRiskId.set(customId, v.riskScenarioId || v.id || customId);
    }
  }

  const toCreate = [];
  const toUpdate = [];

  for (const source of sourceRows) {
    if (vantaByRiskId.has(source.internalId)) {
      toUpdate.push({
        source,
        riskScenarioId: vantaByRiskId.get(source.internalId)
      });
    } else {
      toCreate.push({ source });
    }
  }

  const sourceIds = new Set(sourceRows.map(r => r.internalId));
  const staleInVanta = vantaRows.filter(v => v.riskId && !sourceIds.has(v.riskId));

  return { toCreate, toUpdate, staleInVanta };
}

// ─── Routes ────────────────────────────────────────────────────────────────

router.get('/mock-riskx/risks.json', (req, res) => {
  const { data } = loadRisks();
  res.json(data);
});

router.get('/mock-riskx/_meta.json', (req, res) => {
  const { data, lastModified, mutationCount } = loadRisks();
  const today = new Date();
  const overdueCutoff = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
  res.json({
    source: 'Risk-X — simulated homegrown risk register',
    served: 'GET /mock-riskx/risks.json',
    sourceFile: 'mock-data/risks.json',
    lastModified,
    sessionMutations: mutationCount,
    totalRecords: data.length,
    breakdown: {
      open: data.filter(r => r.status === 'Open').length,
      closed: data.filter(r => r.status === 'Closed').length,
      // Missing/invalid `lastReviewedAt` on an Open risk is treated as
      // overdue — a risk we can't say was last reviewed should be flagged
      // for human review, not silently hidden.
      overdueReview: data.filter(r => r.status === 'Open' && isBeforeOrMissing(r.lastReviewedAt, overdueCutoff)).length,
      byTreatment: {
        Mitigate: data.filter(r => r.treatment === 'Mitigate').length,
        Transfer: data.filter(r => r.treatment === 'Transfer').length,
        Avoid:    data.filter(r => r.treatment === 'Avoid').length,
        Accept:   data.filter(r => r.treatment === 'Accept').length
      },
      byCategory: data.reduce((acc, r) => {
        acc[r.category] = (acc[r.category] || 0) + 1;
        return acc;
      }, {})
    }
  });
});

// JSON body parsing for the mutation routes (the global parser is registered
// AFTER the routers in index.js to avoid breaking the webhook raw body path).
router.use(express.json());

router.post('/mock-riskx/risks', (req, res) => {
  const risk = addRisk();
  res.status(201).json(risk);
});

router.post('/mock-riskx/risks/:id/apply-treatment', (req, res) => {
  const result = applyTreatment(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.risk);
});

router.post('/mock-riskx/risks/:id/close', (req, res) => {
  const result = markClosed(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.risk);
});

router.post('/mock-riskx/reset', (req, res) => {
  resetMutations();
  res.json({ ok: true });
});

module.exports = {
  router,
  loadRisks,
  diffAgainstVanta,
  RISK_CUSTOM_FIELDS,
  // Exposed for the /demo/reset/risk workflow + tests
  _resetMutations: resetMutations
};
