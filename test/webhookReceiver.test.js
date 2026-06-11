const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { Webhook } = require('svix');

const { handleWebhookRequest } = require('../src/webhooks/webhookReceiver');
const eventStore = require('../src/webhooks/eventStore');
const mockWorkflowSink = require('../src/mockWorkflowSink');

// Svix endpoint secrets must be prefixed `whsec_` followed by a base64
// payload. `whsec_dGVzdHNlY3JldA==` decodes to "testsecret" — fine for
// signing/verifying in tests.
const TEST_SECRET = 'whsec_dGVzdHNlY3JldA==';

function signedHeaders(svixId, body, timestamp = Math.floor(Date.now() / 1000)) {
  const wh = new Webhook(TEST_SECRET);
  const signature = wh.sign(svixId, new Date(timestamp * 1000), body);
  return {
    'svix-id':        svixId,
    'svix-timestamp': String(timestamp),
    'svix-signature': signature
  };
}

function makeReq({ headers = {}, body = '' }) {
  return {
    headers,
    body: Buffer.from(body, 'utf-8')
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload)  { this.body = payload; return this; }
  };
  return res;
}

let prevSecret;
beforeEach(() => {
  eventStore._reset();
  mockWorkflowSink._reset();
  prevSecret = process.env.VANTA_WEBHOOK_SECRET;
});
afterEach(() => {
  if (prevSecret === undefined) delete process.env.VANTA_WEBHOOK_SECRET;
  else process.env.VANTA_WEBHOOK_SECRET = prevSecret;
});

describe('handleWebhookRequest — secret unconfigured guardrail', () => {
  test('returns 503 with clear error when VANTA_WEBHOOK_SECRET is unset', async () => {
    delete process.env.VANTA_WEBHOOK_SECRET;
    const req = makeReq({
      headers: signedHeaders('msg_x', '{"type":"x"}'),
      body: '{"type":"x"}'
    });
    const res = makeRes();
    await handleWebhookRequest(req, res);
    assert.strictEqual(res.statusCode, 503);
    assert.match(res.body.error, /secret unconfigured/);
  });

  test('does NOT record an entry when secret is unset (avoids buffer pollution)', async () => {
    delete process.env.VANTA_WEBHOOK_SECRET;
    const req = makeReq({
      headers: signedHeaders('msg_x', '{"type":"x"}'),
      body: '{"type":"x"}'
    });
    await handleWebhookRequest(req, makeRes());
    assert.strictEqual(eventStore.getEvents().length, 0);
  });
});

describe('handleWebhookRequest — signature verification', () => {
  beforeEach(() => { process.env.VANTA_WEBHOOK_SECRET = TEST_SECRET; });

  test('valid signature records event as fresh + verified + forwarded + 200', async () => {
    const body = JSON.stringify({ type: 'test.status_changed', data: { testId: 't-1' } });
    const req = makeReq({ headers: signedHeaders('msg_001', body), body });
    const res = makeRes();
    await handleWebhookRequest(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.received, true);
    assert.strictEqual(res.body.forwarded, true);
    assert.notStrictEqual(res.body.deduped, true);

    const events = eventStore.getEvents();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].svixId, 'msg_001');
    assert.strictEqual(events[0].eventType, 'test.status_changed');
    assert.strictEqual(events[0].verification.ok, true);
    assert.strictEqual(events[0].dedupe.status, 'fresh');
    assert.strictEqual(events[0].processingStatus, 'forwarded');
    assert.strictEqual(events[0].forward.ok, true);
    assert.ok(events[0].forward.payloadId, 'payload id populated');
  });

  test('invalid signature returns 401 + records entry with verification.ok=false', async () => {
    const body = JSON.stringify({ type: 'test.status_changed' });
    const req = makeReq({
      headers: {
        'svix-id':        'msg_bad',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,deadbeef' // not a real signature
      },
      body
    });
    const res = makeRes();
    await handleWebhookRequest(req, res);

    assert.strictEqual(res.statusCode, 401);
    assert.match(res.body.error, /invalid signature/);

    const events = eventStore.getEvents();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].verification.ok, false);
    assert.ok(events[0].verification.error, 'error message captured');
    assert.strictEqual(events[0].processingStatus, 'rejected');
    // svix-id is NOT marked seen on rejected request — retry with correct
    // signature should still be processed.
    assert.strictEqual(eventStore.hasSeenId('msg_bad'), false);
  });

  test('missing svix-signature header returns 401', async () => {
    process.env.VANTA_WEBHOOK_SECRET = TEST_SECRET;
    const body = '{"type":"x"}';
    const req = makeReq({
      headers: {
        'svix-id':        'msg_unsigned',
        'svix-timestamp': String(Math.floor(Date.now() / 1000))
        // no svix-signature
      },
      body
    });
    const res = makeRes();
    await handleWebhookRequest(req, res);
    assert.strictEqual(res.statusCode, 401);
  });

  test('stale timestamp (> Svix tolerance) is rejected', async () => {
    const body = '{"type":"x"}';
    const oldTs = Math.floor(Date.now() / 1000) - 60 * 60; // 1 hour ago
    const req = makeReq({
      headers: signedHeaders('msg_stale', body, oldTs),
      body
    });
    const res = makeRes();
    await handleWebhookRequest(req, res);
    assert.strictEqual(res.statusCode, 401);
    const events = eventStore.getEvents();
    assert.strictEqual(events[0].verification.ok, false);
  });
});

describe('handleWebhookRequest — svix-id dedupe (at-least-once delivery)', () => {
  beforeEach(() => { process.env.VANTA_WEBHOOK_SECRET = TEST_SECRET; });

  test('duplicate svix-id returns 200 with deduped:true and records duplicate entry', async () => {
    const body = JSON.stringify({ type: 'test.status_changed' });

    // First delivery — fresh.
    const req1 = makeReq({ headers: signedHeaders('msg_dup', body), body });
    const res1 = makeRes();
    await handleWebhookRequest(req1, res1);
    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(res1.body.deduped, undefined);

    // Second delivery — same svix-id (Svix retried per at-least-once).
    const req2 = makeReq({ headers: signedHeaders('msg_dup', body), body });
    const res2 = makeRes();
    await handleWebhookRequest(req2, res2);
    assert.strictEqual(res2.statusCode, 200, 'still 200 so Vanta stops retrying');
    assert.strictEqual(res2.body.deduped, true);

    const events = eventStore.getEvents();
    assert.strictEqual(events.length, 2);
    // Newest first — duplicate is index 0.
    assert.strictEqual(events[0].dedupe.status, 'duplicate');
    assert.strictEqual(events[0].processingStatus, 'deduped');
    assert.strictEqual(events[1].dedupe.status, 'fresh');
  });

  test('different svix-id but same body content is NOT deduped (different deliveries)', async () => {
    const body = JSON.stringify({ type: 'test.status_changed' });
    for (const id of ['msg_a', 'msg_b', 'msg_c']) {
      const req = makeReq({ headers: signedHeaders(id, body), body });
      await handleWebhookRequest(req, makeRes());
    }
    const events = eventStore.getEvents();
    assert.strictEqual(events.length, 3);
    assert.ok(events.every(e => e.dedupe.status === 'fresh'));
  });
});

describe('handleWebhookRequest — privacy of recorded entry', () => {
  beforeEach(() => { process.env.VANTA_WEBHOOK_SECRET = TEST_SECRET; });

  test('recorded entry does NOT include the svix-signature header', async () => {
    const body = '{"type":"x"}';
    const headers = signedHeaders('msg_priv', body);
    const req = makeReq({ headers, body });
    await handleWebhookRequest(req, makeRes());

    const event = eventStore.getEvents()[0];
    // None of the entry's values should be the signature string.
    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes(headers['svix-signature']), 'signature not leaked into the buffer');
  });

  test('recorded entry does NOT include the secret', async () => {
    const body = '{"type":"x"}';
    const req = makeReq({ headers: signedHeaders('msg_secret', body), body });
    await handleWebhookRequest(req, makeRes());
    const serialized = JSON.stringify(eventStore.getEvents()[0]);
    assert.ok(!serialized.includes(TEST_SECRET), 'secret not leaked into the buffer');
  });

  test('body preview is truncated at BODY_PREVIEW_CHARS for large payloads', async () => {
    const huge = JSON.stringify({ type: 'big', filler: 'x'.repeat(eventStore.BODY_PREVIEW_CHARS) });
    const req = makeReq({ headers: signedHeaders('msg_big', huge), body: huge });
    await handleWebhookRequest(req, makeRes());
    const event = eventStore.getEvents()[0];
    assert.ok(event.bodyPreview.length <= eventStore.BODY_PREVIEW_CHARS + 1);
  });
});

describe('handleWebhookRequest — no legacy sync triggers', () => {
  beforeEach(() => { process.env.VANTA_WEBHOOK_SECRET = TEST_SECRET; });

  test('person.* event forwards as a payload, never triggers a personnel sync', async () => {
    // The previous receiver called runPersonnelSync() for person.created /
    // person.updated / person.offboarded. PR A removed that outright; the
    // receiver now routes the event to Workflow Sink as a neutral payload.
    const body = JSON.stringify({ type: 'person.offboarded', data: { id: 'p-1' } });
    const req = makeReq({ headers: signedHeaders('msg_person', body), body });
    const res = makeRes();
    await handleWebhookRequest(req, res);

    assert.strictEqual(res.statusCode, 200);
    const event = eventStore.getEvents()[0];
    assert.strictEqual(event.eventType, 'person.offboarded');
    assert.strictEqual(event.processingStatus, 'forwarded');
    assert.strictEqual(event.forward.ok, true);

    // Payload landed in Workflow Sink — not a Vanta sync.
    const payloads = mockWorkflowSink.loadPayloads();
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].vantaEvent, 'person.offboarded');
  });

  test('vulnerability.* event forwards as a payload, never triggers vuln sync', async () => {
    const body = JSON.stringify({ type: 'vulnerability.created', data: { id: 'v-1' } });
    const req = makeReq({ headers: signedHeaders('msg_vuln', body), body });
    const res = makeRes();
    await handleWebhookRequest(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(eventStore.getEvents()[0].processingStatus, 'forwarded');
    assert.strictEqual(mockWorkflowSink.loadPayloads()[0].vantaEvent, 'vulnerability.created');
  });
});

describe('handleWebhookRequest — forward integration', () => {
  beforeEach(() => { process.env.VANTA_WEBHOOK_SECRET = TEST_SECRET; });

  test('Workflow Sink receives the payload alongside the ring-buffer entry (real-shape Vanta delivery)', async () => {
    // Real Vanta delivery shape: entity object at root, no `type` field.
    // Falls back to DEFAULT_HINT but vantaObject is still populated.
    const body = JSON.stringify({ questionnaire: { id: 'qst-1' } });
    const req = makeReq({ headers: signedHeaders('msg_fwd', body), body });
    await handleWebhookRequest(req, makeRes());

    const payloads = mockWorkflowSink.loadPayloads();
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].source, 'vanta');
    assert.strictEqual(payloads[0].vantaObject.id, 'qst-1');
    assert.strictEqual(payloads[0].vantaObject.type, 'questionnaire');
    assert.strictEqual(payloads[0].vantaEvent, 'v1.questionnaire.*');

    // The ring-buffer entry's forward.payloadId matches the Workflow Sink id.
    const event = eventStore.getEvents()[0];
    assert.strictEqual(event.forward.payloadId, payloads[0].id);
  });

  test('demo-shaped event forwards with full polish (workflow hints from EVENT_HINTS)', async () => {
    const body = JSON.stringify({
      _demo: true,
      _demoEventType: 'v1.questionnaire.export-failed',
      questionnaire: { id: 'qst-2' }
    });
    const req = makeReq({ headers: signedHeaders('msg_demo_fwd', body), body });
    await handleWebhookRequest(req, makeRes());

    const payloads = mockWorkflowSink.loadPayloads();
    assert.strictEqual(payloads[0].vantaEvent, 'v1.questionnaire.export-failed');
    assert.match(payloads[0].summary, /export failed/i);
    assert.ok(payloads[0].workflowHints.some(h => /re-run|escalate/i.test(h)));
  });

  test('duplicate svix-id does NOT re-forward to Workflow Sink', async () => {
    // At-least-once delivery means Vanta retries. We must not create a
    // duplicate payload on the retry.
    const body = JSON.stringify({ questionnaire: { id: 'qst-dup' } });
    const headers = signedHeaders('msg_dup_fwd', body);

    await handleWebhookRequest(makeReq({ headers, body }), makeRes());
    await handleWebhookRequest(makeReq({ headers, body }), makeRes());

    const payloads = mockWorkflowSink.loadPayloads();
    assert.strictEqual(payloads.length, 1, 'second delivery deduped — no duplicate payload');
  });

  test('rejected signature does NOT forward', async () => {
    const body = JSON.stringify({ questionnaire: { id: 'qst-1' } });
    const req = makeReq({
      headers: {
        'svix-id':        'msg_bad_fwd',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,deadbeef'
      },
      body
    });
    await handleWebhookRequest(req, makeRes());

    assert.strictEqual(mockWorkflowSink.loadPayloads().length, 0, 'no payload for rejected signature');
  });

  test('unrecognized body shape forwards with default workflow hints', async () => {
    // No top-level entity object, no _demoEventType, no type. As honest a
    // fall-through as we can give — DEFAULT_HINT, unknown vantaEvent.
    const body = JSON.stringify({ unrecognized: 'shape', no: 'entity' });
    const req = makeReq({ headers: signedHeaders('msg_unknown', body), body });
    await handleWebhookRequest(req, makeRes());

    const payload = mockWorkflowSink.loadPayloads()[0];
    assert.strictEqual(payload.vantaEvent, 'unknown');
    assert.ok(payload.workflowHints.some(h => /Review in Vanta/.test(h)));
  });
});
