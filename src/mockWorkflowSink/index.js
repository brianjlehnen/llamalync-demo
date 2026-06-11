const express = require('express');

/**
 * Fake "Workflow Sink" — stands in for whatever compliance workflow system the
 * customer routes Vanta events into. Same pattern as mockHris / mockCmdb /
 * mockRiskRegister / mockEvidenceStore, with an inverted flow direction:
 * Workflow Sink is a DESTINATION (it receives data from LlamaLync), not a
 * SOURCE (LlamaLync reads from it).
 *
 * The lesson is not that Vanta events become tickets. It is that Vanta emits
 * workflow events, LlamaLync verifies and dedupes them, then transforms them
 * into whatever payload the downstream compliance workflow system expects.
 * The destination in a real integration might be Jira, Linear, Slack,
 * Salesforce, Coupa, or a homegrown GRC queue — LlamaLync doesn't pretend to
 * know which.
 *
 * Promotion path: when LlamaLync deploys, /mock-workflow-sink deploys with it.
 * For a real customer integration, swap `receivePayload()` to POST to the
 * customer's actual workflow API — the rest of the forward pipeline stays
 * the same.
 *
 * Payload shape is deliberately neutral: a structured event envelope
 * (`source` / `vantaEvent` / `vantaObject` / `summary` / `workflowHints` /
 * `rawEvent`) rather than a JSON dump. No severity field — priority and
 * routing rules belong to the destination system, not to LlamaLync.
 */
const router = express.Router();

// In-memory store of forwarded payloads, newest first. Capped at the most
// recent N entries; older fall off FIFO. Resets on restart.
const MAX_PAYLOADS = 50;
let payloads = [];
let receivedCounter = 0;

function receivePayload(payload) {
  receivedCounter += 1;
  const entry = {
    id: `payload-${String(receivedCounter).padStart(4, '0')}`,
    receivedAt: new Date().toISOString(),
    ...payload
  };
  payloads.unshift(entry);
  if (payloads.length > MAX_PAYLOADS) payloads.length = MAX_PAYLOADS;
  return entry;
}

function loadPayloads() {
  // Defensive copy so callers can't mutate the store via held references.
  return payloads.map(p => ({ ...p }));
}

function _reset() {
  payloads = [];
  receivedCounter = 0;
}

// ─── Routes ────────────────────────────────────────────────────────────────

router.get('/mock-workflow-sink/payloads.json', (req, res) => {
  res.json(loadPayloads());
});

router.get('/mock-workflow-sink/_meta.json', (req, res) => {
  const list = loadPayloads();
  const byFamily = list.reduce((acc, p) => {
    const key = p.vantaObject?.type || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const byVantaEvent = list.reduce((acc, p) => {
    const key = p.vantaEvent || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  res.json({
    source: 'Workflow Sink — simulated downstream compliance workflow destination',
    served: 'GET /mock-workflow-sink/payloads.json',
    totalReceived: receivedCounter,
    currentBufferSize: list.length,
    bufferCap: MAX_PAYLOADS,
    breakdown: { byFamily, byVantaEvent },
    lastReceivedAt: list[0]?.receivedAt || null
  });
});

router.use(express.json());

router.post('/mock-workflow-sink/reset', (req, res) => {
  _reset();
  res.json({ ok: true });
});

module.exports = {
  router,
  receivePayload,
  loadPayloads,
  _reset,
  MAX_PAYLOADS
};
