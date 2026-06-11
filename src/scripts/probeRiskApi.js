/**
 * Surgical probe of the /v1/risk-scenarios surface.
 *
 * Answers four open questions from docs/scenarios/risk.md §9 without polluting
 * the tenant with the full 18-row Risk-X mock register:
 *
 *   Q1  POST with duplicate riskId — 409, silent-create, or upsert?
 *   Q2  PATCH with omitted residual fields — null them, or preserve?
 *   Q3  PATCH path: does custom riskId work, or strictly Mongo ID?
 *   Q4  Unknown owner email — structured error, or silent null?
 *
 * Creates one or two probe risks with the prefix LLAMALYNC-PROBE-{YMD}-{HM}.
 * Probe 5 normally fails validation for the unknown owner, so only 001 is
 * expected to linger. No DELETE endpoint exists, so any successful probe risks
 * must be manually removed via the Vanta UI.
 *
 * Run: `node src/scripts/probeRiskApi.js`
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { manageClient } = require('../http/vantaClient');

const RISK_SCENARIOS_PATH = '/v1/risk-scenarios';

function requireRiskRegister() {
  const riskRegister = process.env.VANTA_RISK_REGISTER;
  if (!riskRegister) {
    throw new Error(
      'VANTA_RISK_REGISTER must be set before probing /v1/risk-scenarios. ' +
      'The live probe confirmed Vanta rejects writes without riskRegister.'
    );
  }
  return riskRegister;
}

function timestampSuffix() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hm = now.toTimeString().slice(0, 5).replace(':', '');
  return `${ymd}-${hm}`;
}

function probeIdFor(stamp, suffix) {
  return `LLAMALYNC-PROBE-${stamp}-${suffix}`;
}

function buildProbePayload(riskId, riskRegister, overrides = {}) {
  return {
    riskId,
    description:
      `LlamaLync API probe (${riskId}) — safe to delete.\n\n` +
      `Created by src/scripts/probeRiskApi.js to verify Vanta /v1/risk-scenarios semantics.`,
    categories: ['Access Control'],
    ciaCategories: ['Confidentiality'],
    likelihood: 2,
    impact: 2,
    treatment: 'Mitigate',
    residualLikelihood: 1,
    residualImpact: 2,
    note: 'Probe-generated risk. Remove via Vanta UI when convenient.',
    riskRegister,
    ...overrides
  };
}

function shortJson(value, max = 1200) {
  const s = JSON.stringify(value, null, 2);
  return s && s.length > max ? s.slice(0, max) + '\n... [truncated]' : s;
}

async function probe(label, fn) {
  console.log('');
  console.log('═══ ' + label + ' ═══');
  try {
    const result = await fn();
    console.log('OK · response body:');
    console.log(shortJson(result));
    return { ok: true, result };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.log(`ERROR · status=${status}`);
    console.log('body:');
    console.log(shortJson(body));
    return { ok: false, status, body, message: err.message };
  }
}

function pickRiskScenarioFromResponse(resp) {
  if (!resp) return null;
  return resp.data || resp.results?.data || resp;
}

async function main() {
  const riskRegister = requireRiskRegister();
  const stamp = timestampSuffix();
  const probe001 = probeIdFor(stamp, '001');
  const probe002 = probeIdFor(stamp, '002');

  console.log('Probe run · timestamp:', stamp);
  console.log('Probe risk IDs:');
  console.log('  001:', probe001);
  console.log('  002:', probe002, '(unknown-owner probe)');
  console.log('');
  console.log('Endpoint:', RISK_SCENARIOS_PATH);
  console.log('Risk register:', riskRegister);
  console.log('Bucket: Manage Vanta (50 req/min)');

  // ─── Probe 1 — POST with custom riskId ──────────────────────────────
  const p1 = await probe(
    `Probe 1 · POST with custom riskId (${probe001})`,
    async () => manageClient.post(RISK_SCENARIOS_PATH, buildProbePayload(probe001, riskRegister))
  );

  // ─── Probe 2 — Duplicate POST (same riskId) ─────────────────────────
  const p2 = await probe(
    'Probe 2 · POST same riskId again — duplicate behavior',
    async () => manageClient.post(
      RISK_SCENARIOS_PATH,
      buildProbePayload(probe001, riskRegister, {
        description: `LlamaLync API probe (${probe001}) — duplicate POST attempt #2. Safe to delete.`
      })
    )
  );

  // ─── Probe 3 — PATCH with custom riskId in path ─────────────────────
  const p3 = await probe(
    `Probe 3 · PATCH /v1/risk-scenarios/${probe001} (custom ID in path)`,
    async () => manageClient.patch(
      `${RISK_SCENARIOS_PATH}/${encodeURIComponent(probe001)}`,
      { note: 'Probe 3: PATCH via custom riskId in path.' }
    )
  );

  // ─── Probe 4 — PATCH omitting residual fields ───────────────────────
  // 4a: read current state so we can compare residual before and after.
  const p4a = await probe(
    `Probe 4a · GET /v1/risk-scenarios/${probe001} (before omit-PATCH)`,
    async () => manageClient.get(`${RISK_SCENARIOS_PATH}/${encodeURIComponent(probe001)}`)
  );

  // 4b: PATCH with residual fields deliberately omitted, only changing the note.
  const p4b = await probe(
    'Probe 4b · PATCH with residualLikelihood/residualImpact OMITTED',
    async () => manageClient.patch(
      `${RISK_SCENARIOS_PATH}/${encodeURIComponent(probe001)}`,
      { note: 'Probe 4: residual fields intentionally omitted from this PATCH body.' }
    )
  );

  // 4c: read back and compare.
  const p4c = await probe(
    `Probe 4c · GET /v1/risk-scenarios/${probe001} (after omit-PATCH)`,
    async () => manageClient.get(`${RISK_SCENARIOS_PATH}/${encodeURIComponent(probe001)}`)
  );

  // ─── Probe 5 — Unknown owner email ──────────────────────────────────
  const p5 = await probe(
    `Probe 5 · POST with unknown owner email (${probe002})`,
    async () => manageClient.post(
      RISK_SCENARIOS_PATH,
      buildProbePayload(probe002, riskRegister, {
        owner: `nonexistent-${Date.now()}@nowhere.example`,
        description:
          `LlamaLync API probe (${probe002}) — unknown owner test. Safe to delete.\n\n` +
          `Captures Vanta's response shape for an owner email that does not resolve to a Vanta user.`
      })
    )
  );

  // ─── Summary ────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');

  const p1Scenario = pickRiskScenarioFromResponse(p1.result);
  const p4aResidual = {
    likelihood: pickRiskScenarioFromResponse(p4a.result)?.residualLikelihood,
    impact: pickRiskScenarioFromResponse(p4a.result)?.residualImpact
  };
  const p4cResidual = {
    likelihood: pickRiskScenarioFromResponse(p4c.result)?.residualLikelihood,
    impact: pickRiskScenarioFromResponse(p4c.result)?.residualImpact
  };

  console.log('');
  console.log('Probe 1 (POST custom riskId):');
  console.log('  status:', p1.ok ? 'OK' : `ERROR ${p1.status}`);
  if (p1Scenario) {
    console.log('  echoed riskId       :', p1Scenario.riskId);
    console.log('  Vanta riskScenarioId:', p1Scenario.riskScenarioId || p1Scenario.id);
  }

  console.log('');
  console.log('Probe 2 (duplicate POST):');
  console.log('  status:', p2.ok ? `OK (${p2.result ? '200/201' : 'unknown'})` : `ERROR ${p2.status}`);
  console.log('  ▶ Q1 interpretation:');
  if (p2.ok) {
    console.log('    Vanta accepted a duplicate riskId POST — list-and-diff is REQUIRED');
    console.log('    to prevent duplicate scenarios on every sync.');
  } else if (p2.status === 409) {
    console.log('    Vanta returns 409 on duplicate — server-side unique constraint enforced.');
    console.log('    Our list-and-diff is defensively correct but not strictly required.');
  } else if (p2.status === 422) {
    console.log('    Vanta returns 422 on duplicate riskId — unique constraint enforced.');
    console.log('    Our list-and-diff is REQUIRED to avoid validation failures on every sync.');
  } else {
    console.log(`    Unexpected status ${p2.status} — read body above and re-evaluate.`);
  }

  console.log('');
  console.log('Probe 3 (PATCH via custom riskId in path):');
  console.log('  status:', p3.ok ? 'OK' : `ERROR ${p3.status}`);
  console.log('  ▶ Q3 interpretation:');
  if (p3.ok) {
    console.log('    Custom riskId works in PATCH path. Our diff helper may surface either form.');
  } else {
    console.log('    Custom riskId rejected — diff helper MUST prefer Vanta-returned object ID.');
  }

  console.log('');
  console.log('Probe 4 (PATCH with residual omitted):');
  console.log('  before omit-PATCH · residual:', JSON.stringify(p4aResidual));
  console.log('  after  omit-PATCH · residual:', JSON.stringify(p4cResidual));
  console.log('  ▶ Q2 interpretation:');
  if (p4aResidual.likelihood === p4cResidual.likelihood &&
      p4aResidual.impact === p4cResidual.impact) {
    console.log('    PATCH preserves omitted residual fields (partial-update semantics).');
    console.log('    To CLEAR residual via PATCH, send explicit `residualLikelihood: null`.');
    console.log('    transformRisk MAY NEED TO CHANGE: untreated risks should send explicit null,');
    console.log('    not just omit, so a previously-treated risk becomes inherent-only in Vanta.');
  } else if (p4cResidual.likelihood == null && p4cResidual.impact == null) {
    console.log('    PATCH nulled the residual fields when omitted from the body.');
    console.log('    Our current omit-on-untreated transformRisk behavior is correct as-is.');
  } else {
    console.log('    Unclear — residual changed in a non-obvious way; inspect bodies above.');
  }

  console.log('');
  console.log('Probe 5 (unknown owner):');
  console.log('  status:', p5.ok ? 'OK (Vanta accepted unknown owner)' : `ERROR ${p5.status}`);
  console.log('  ▶ Q4 interpretation:');
  if (!p5.ok) {
    console.log('    Vanta rejected the unknown owner with a structured error.');
    console.log('    Our preflight is the right defense — confirms the fallback path matters.');
  } else if (p5.result) {
    const sc = pickRiskScenarioFromResponse(p5.result);
    console.log('    Vanta accepted the unknown owner. owner field on response:', JSON.stringify(sc?.owner));
    console.log('    Either Vanta silently null-ed it or wrote it raw — inspect response above.');
  }

  console.log('');
  console.log('───────────────────────────────────────────────────────────');
  console.log('Cleanup: successful probe risks remain in the tenant.');
  console.log('  Visit Vanta UI → Risk Management to delete:');
  console.log('   ', probe001);
  if (p5.ok) {
    console.log('   ', probe002);
  } else {
    console.log('   ', probe002, '(not expected to exist because Probe 5 failed validation)');
  }
  console.log('───────────────────────────────────────────────────────────');
}

main().catch(err => {
  console.error('Probe script crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
