const express = require('express');
const { Webhook, WebhookVerificationError } = require('svix');
const logger = require('../utils/logger');
const eventStore = require('./eventStore');
const { forwardEvent, deriveEventType } = require('./webhookForward');

// 1 MB cap — generous for any legitimate Vanta payload while bounding the
// damage a slow / malformed POST can do.
const MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024;

// Vanta switched its outbound webhooks to Svix. Each delivery carries:
//   svix-id          — unique per delivery (at-least-once dedupe key)
//   svix-timestamp   — Unix seconds (replay-window enforcement)
//   svix-signature   — HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`
// Public docs: https://developer.vanta.com/docs/webhooks
//
// The svix library handles header parsing, timestamp tolerance, and the
// signature compare against potentially multiple space-separated signatures
// (key-rotation support). Hand-rolling that surface is error-prone, so we
// depend on the official package.
function registerWebhookRoute(app) {
  const rawParser = express.raw({ type: '*/*', limit: MAX_WEBHOOK_BODY_BYTES });
  app.post('/webhooks/vanta', rawParser, handleWebhookRequest);
  logger.info('[Webhooks] Route registered: POST /webhooks/vanta (Svix verification)');
}

// Extracted from the registerWebhookRoute closure so tests can drive it
// directly with a fake req/res — no Express ephemeral server needed.
async function handleWebhookRequest(req, res) {
  const rawBody = req.body && Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '';
  const svixId        = headerString(req.headers['svix-id']);
  const svixTimestamp = headerString(req.headers['svix-timestamp']);
  const receivedAt    = new Date().toISOString();

  // Secret unconfigured — return 503 so Vanta retries once the operator
  // sets VANTA_WEBHOOK_SECRET. Better than silently 200'ing (data would
  // be lost) or 500'ing (looks like our bug). NOT recorded in the event
  // store: pre-config probes shouldn't push real events out of the buffer.
  const secret = process.env.VANTA_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('Webhook received but VANTA_WEBHOOK_SECRET is unset — returning 503', { svixId });
    return res.status(503).json({ error: 'webhook secret unconfigured' });
  }

  // Svix verification: builds the expected signed string, HMACs it with
  // the secret, constant-time-compares against each signature in the
  // svix-signature header. Throws WebhookVerificationError on any failure
  // (missing header, bad signature, stale timestamp).
  const wh = new Webhook(secret);
  let parsedEvent = null;
  let verification = { ok: true, error: null };
  try {
    parsedEvent = wh.verify(rawBody, {
      'svix-id':        svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': headerString(req.headers['svix-signature'])
    });
  } catch (err) {
    verification = {
      ok: false,
      error: err instanceof WebhookVerificationError ? err.message : `verify error: ${err.message}`
    };
  }

  // deriveEventType handles the real Vanta payload shape (entity object at
  // the root, no `type` field) by checking the demo marker first, then
  // event.type for forward-compat, then inferring from the body's
  // top-level entity key. Falls back to the legacy extractor for the
  // edge case where parsedEvent is unavailable but rawBody is.
  const eventType = deriveEventType(parsedEvent) || extractEventType(rawBody);

  // Failed signature still gets recorded — operator wants to see *that*
  // something arrived and was rejected, not just silence. Body preview is
  // truncated; the signature header is NOT captured (it's secret-derived
  // and not useful for triage).
  if (!verification.ok) {
    logger.warn('Webhook rejected: signature verification failed', {
      svixId, error: verification.error
    });
    eventStore.recordEvent({
      svixId, svixTimestamp, receivedAt, eventType,
      bodyPreview: eventStore.previewBody(rawBody),
      verification,
      dedupe: { status: 'n/a' },
      processingStatus: 'rejected'
    });
    return res.status(401).json({ error: 'invalid signature' });
  }

  // Dedupe by svix-id. At-least-once delivery means duplicates are
  // expected; the right answer is to ack 200 (so Vanta stops retrying)
  // but skip downstream processing. The store entry still records the
  // duplicate so operators can see Vanta is retrying.
  if (svixId && eventStore.hasSeenId(svixId)) {
    logger.info('Webhook duplicate skipped (already seen svix-id)', { svixId, eventType });
    eventStore.recordEvent({
      svixId, svixTimestamp, receivedAt, eventType,
      bodyPreview: eventStore.previewBody(rawBody),
      verification,
      dedupe: { status: 'duplicate' },
      processingStatus: 'deduped'
    });
    return res.status(200).json({ received: true, deduped: true });
  }

  if (svixId) eventStore.markSeen(svixId);

  // Forward synchronously to Workflow Sink. In-process call so latency is
  // negligible; we ack Vanta only after the destination has the payload
  // (or we've recorded the failure). Forward failures are captured on
  // the entry but DON'T fail the webhook — Vanta retrying wouldn't help
  // if our destination is down, and we already deduped against svix-id.
  const forward = await forwardEvent(parsedEvent);

  eventStore.recordEvent({
    svixId, svixTimestamp, receivedAt, eventType,
    bodyPreview: eventStore.previewBody(rawBody),
    verification,
    dedupe: { status: 'fresh' },
    forward,
    processingStatus: forward.ok ? 'forwarded' : 'forward-failed'
  });

  logger.info('Webhook recorded', { svixId, eventType, forwarded: forward.ok });
  return res.status(200).json({ received: true, forwarded: forward.ok });
}

// Express collapses repeated headers into arrays. We expect single-value
// headers from Svix; coerce to a string so the svix library sees the
// expected shape. Returns '' for missing — svix will reject that cleanly.
function headerString(value) {
  if (Array.isArray(value)) return value[0] || '';
  if (typeof value === 'string') return value;
  return '';
}

// Best-effort event type extraction when signature verification failed and
// we can't trust the parsed event. Used only for the audit ring buffer
// entry — never for routing.
function extractEventType(rawBody) {
  if (typeof rawBody !== 'string' || rawBody.length === 0) return null;
  try {
    const parsed = JSON.parse(rawBody);
    return typeof parsed?.type === 'string' ? parsed.type : null;
  } catch {
    return null;
  }
}

module.exports = {
  registerWebhookRoute,
  handleWebhookRequest,
  headerString,
  extractEventType
};
