const { Webhook } = require('svix');
const { handleWebhookRequest } = require('./webhookReceiver');

/**
 * Demo replay — synthesize a signed Vanta webhook and feed it through the
 * real receiver pipeline. Lets the demo proceed without depending on a
 * tenant being configured to emit live webhooks during the call.
 *
 * Signed with the configured `VANTA_WEBHOOK_SECRET` so it passes the
 * receiver's Svix verification path — no special "demo mode" bypass.
 * Routes through `handleWebhookRequest` directly (same path as the
 * Express route uses), so behavior is byte-identical to a real delivery
 * from Vanta's webhook service.
 *
 * Sample body shape mirrors what Vanta actually delivers (empirically
 * captured 2026-05-19 from a live Render-deployed receiver):
 *   - The entity object lives at the top level, keyed by entity name
 *     (e.g. `{"questionnaire": {"id": "qst-001"}}`).
 *   - The event type is NOT in the body. To still drive a polished demo,
 *     samples include a synthetic `_demoEventType` field that
 *     `transformEventToPayload` reads as the highest-priority type signal.
 *     Real Vanta deliveries don't have it.
 *   - `_demo: true` + `_note` mark these as fixtures — visible in the
 *     rawEvent dump on Workflow Sink payloads so a cold SE can tell a
 *     replay from a real delivery.
 */

const SAMPLES = Object.freeze([
  Object.freeze({
    _demo: true,
    _demoEventType: 'v1.questionnaire.created',
    _note: 'Demo sample — Vanta does not include event type in real payloads; this field is synthetic.',
    questionnaire: { id: 'qst-demo-001', name: 'Acme Corp — vendor questionnaire' }
  }),
  Object.freeze({
    _demo: true,
    _demoEventType: 'v1.questionnaire.export-failed',
    _note: 'Demo sample — Vanta does not include event type in real payloads; this field is synthetic.',
    questionnaire: { id: 'qst-demo-002', exportId: 'exp-7f3e' }
  }),
  Object.freeze({
    _demo: true,
    _demoEventType: 'v1.trust-center.access-request.received',
    _note: 'Demo sample — Vanta does not include event type in real payloads; this field is synthetic.',
    accessRequest: { id: 'req-demo-001', email: 'prospect@acme.example.com', company: 'Acme Corp' }
  }),
  Object.freeze({
    _demo: true,
    _demoEventType: 'v1.vendor.decision.created',
    _note: 'Demo sample — Vanta does not include event type in real payloads; this field is synthetic.',
    vendorDecision: { id: 'vd-demo-001', vendor: 'Stripe', decision: 'approved' }
  })
]);

// Rotation state. Counter cycles deterministically through SAMPLES; the
// last svix-id is remembered so the dedupe-test button can replay it.
let sampleCounter = 0;
let freshIdCounter = 0;
let lastReplaySvixId = null;

function freshSvixId() {
  freshIdCounter += 1;
  return `msg_demo_${Date.now().toString(36)}_${String(freshIdCounter).padStart(4, '0')}`;
}

function makeFakeReq(rawBody, headers) {
  return { headers, body: Buffer.from(rawBody, 'utf-8') };
}

function makeFakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

/**
 * @param {object}  options
 * @param {boolean} options.dedupeTest  If true, re-use the last replay's
 *                                       svix-id so the receiver hits the
 *                                       dedupe path (200 deduped, no
 *                                       second Workflow Sink payload).
 *                                       Returns 400 if no prior replay exists.
 */
async function runReplay({ dedupeTest = false } = {}) {
  const secret = process.env.VANTA_WEBHOOK_SECRET;
  if (!secret) {
    return {
      ok: false,
      statusCode: 503,
      error: 'webhook secret unconfigured — set VANTA_WEBHOOK_SECRET to enable demo replay'
    };
  }

  if (dedupeTest && !lastReplaySvixId) {
    return {
      ok: false,
      statusCode: 400,
      error: 'no prior replay to dedupe — trigger a fresh demo event first'
    };
  }

  const sample = SAMPLES[sampleCounter % SAMPLES.length];
  sampleCounter += 1;
  const rawBody = JSON.stringify(sample);

  const svixId        = dedupeTest ? lastReplaySvixId : freshSvixId();
  const svixTimestamp = Math.floor(Date.now() / 1000);

  // Sign with the real secret so the receiver's verify() accepts it —
  // we deliberately route through the same code path as a real webhook.
  const wh = new Webhook(secret);
  const svixSignature = wh.sign(svixId, new Date(svixTimestamp * 1000), rawBody);

  const req = makeFakeReq(rawBody, {
    'svix-id':        svixId,
    'svix-timestamp': String(svixTimestamp),
    'svix-signature': svixSignature
  });
  const res = makeFakeRes();
  await handleWebhookRequest(req, res);

  if (!dedupeTest) lastReplaySvixId = svixId;

  return {
    ok: true,
    statusCode: res.statusCode,
    receiverResponse: res.body,
    eventType: sample._demoEventType,
    svixId,
    dedupeTest,
    deduped: !!(res.body && res.body.deduped),
    forwarded: !!(res.body && res.body.forwarded)
  };
}

function _reset() {
  sampleCounter = 0;
  freshIdCounter = 0;
  lastReplaySvixId = null;
}

module.exports = {
  runReplay,
  SAMPLES,
  _reset
};
