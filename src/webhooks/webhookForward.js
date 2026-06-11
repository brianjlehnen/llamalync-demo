const { receivePayload } = require('../mockWorkflowSink');
const logger = require('../utils/logger');

/**
 * Transform a verified Vanta webhook event into a neutral workflow-sink
 * payload and forward it to the destination mock.
 *
 * Empirical reality (verified 2026-05-19 against a live Vanta delivery
 * from a deployed Render instance):
 *   - Vanta's public webhook docs do NOT specify how the event type is
 *     conveyed in the delivered payload. The full type (e.g.
 *     `v1.questionnaire.created`) is visible in Vanta's Svix dashboard
 *     but is NOT present in the body and NOT present in any custom
 *     header — only the three standard `svix-*` headers ship.
 *   - The body for `v1.questionnaire.created` was literally
 *     `{"questionnaire": {"id": "123"}}`. The entity name is the top-
 *     level key; the entity object has `id`. The lifecycle stage
 *     (created / deleted / status-changed / export-completed /
 *     export-failed) is NOT recoverable from the delivered payload.
 *
 * Implications for this transform:
 *   - We can't lookup exact workflow hints for the real Vanta delivery
 *     because we don't know the exact event type. Falls through to
 *     DEFAULT_HINT with an honest message.
 *   - For demo replay, samples set `_demoEventType` on the body so the
 *     replay path can show the polished per-type payload. Real Vanta
 *     payloads won't have this field; nothing leaks.
 *   - We DO extract the entity (questionnaire / accessRequest /
 *     vendorDecision / etc.) from the top-level body key so the
 *     payload's vantaObject is meaningful even on real deliveries.
 *   - Lookup also checks `event.type` for forward-compat in case Vanta
 *     eventually adds it.
 *
 * Payload shape (deliberately neutral — LlamaLync makes no assumption
 * about what the downstream workflow system expects):
 *   {
 *     source:        'vanta',
 *     vantaEvent:    'v1.questionnaire.created' | 'v1.questionnaire.*' | 'unknown',
 *     vantaObject:   { type: 'questionnaire', id: '123' },
 *     summary:       'Questionnaire created · 123',
 *     workflowHints: ['Review in Vanta', 'Route to GRC owner', ...],
 *     rawEvent:      { ... original Vanta body ... }
 *   }
 *
 * No severity field — priority is the destination system's call (Jira
 * priority, Slack color, Salesforce task urgency, Coupa state, internal
 * GRC routing rules all differ). LlamaLync surfaces neutral hints; the
 * downstream system maps them to its own taxonomy.
 */

// Real Vanta v1.* event catalog (verified against the customer's webhook
// subscription UI on 2026-05-19). Until Vanta delivers the type in the
// webhook payload, this table is reachable only via the demo replay path
// (which sets `_demoEventType`) or via a future Vanta payload change.
const EVENT_HINTS = Object.freeze({
  // Questionnaire lifecycle
  'v1.questionnaire.created': Object.freeze({
    summaryPrefix: 'Questionnaire created',
    workflowHints: Object.freeze([
      'Review in Vanta',
      'Route to GRC owner',
      'Assign a reviewer for the new questionnaire'
    ])
  }),
  'v1.questionnaire.deleted': Object.freeze({
    summaryPrefix: 'Questionnaire deleted',
    workflowHints: Object.freeze([
      'Confirm the deletion was intentional',
      'Verify the audit trail captured who removed it'
    ])
  }),
  'v1.questionnaire.status-changed': Object.freeze({
    summaryPrefix: 'Questionnaire status changed',
    workflowHints: Object.freeze([
      'Confirm the new status in Vanta',
      'Notify downstream stakeholders'
    ])
  }),
  'v1.questionnaire.export-completed': Object.freeze({
    summaryPrefix: 'Questionnaire export completed',
    workflowHints: Object.freeze([
      'Deliver the export to the requester',
      'Attach to the open security review'
    ])
  }),
  'v1.questionnaire.export-failed': Object.freeze({
    summaryPrefix: 'Questionnaire export failed',
    workflowHints: Object.freeze([
      'Re-run the export from Vanta',
      'Investigate source data if it fails again',
      'Escalate to Vanta support if needed'
    ])
  }),
  // Trust Center access requests
  'v1.trust-center.access-request.received': Object.freeze({
    summaryPrefix: 'Trust Center access request received',
    workflowHints: Object.freeze([
      'Review the requester',
      'Approve or deny within documented SLA'
    ])
  }),
  'v1.trust-center.access-request.approved': Object.freeze({
    summaryPrefix: 'Trust Center access approved',
    workflowHints: Object.freeze([
      'Provision access in any gated downstream systems',
      'Notify the requester'
    ])
  }),
  'v1.trust-center.access-request.denied': Object.freeze({
    summaryPrefix: 'Trust Center access denied',
    workflowHints: Object.freeze([
      'Confirm the denial reason is logged',
      'Notify the requester'
    ])
  }),
  // Vendor decisions
  'v1.vendor.decision.created': Object.freeze({
    summaryPrefix: 'Vendor decision recorded',
    workflowHints: Object.freeze([
      'Review the decision in Vanta',
      'Update procurement workflow if applicable',
      'Update risk register if applicable'
    ])
  })
});

// Fallback when neither a known event type nor an entity inference applies.
const DEFAULT_HINT = Object.freeze({
  summaryPrefix: 'Vanta workflow event received',
  workflowHints: Object.freeze([
    'Review in Vanta',
    'Vanta does not include the event type in the delivered payload — the specific lifecycle stage is not recoverable from the webhook alone'
  ])
});

// Family-level summary prefixes for the real-Vanta-delivery path where we
// can infer the entity but not the lifecycle stage. Keeps the summary
// honest ("event received from Vanta") rather than guessing a verb.
const FAMILY_SUMMARY_PREFIX = Object.freeze({
  'v1.questionnaire.*':               'Questionnaire event received from Vanta',
  'v1.trust-center.access-request.*': 'Trust Center access request event received from Vanta',
  'v1.vendor.decision.*':             'Vendor decision event received from Vanta'
});

// Keys we skip when scanning the body for the entity object. Demo replays
// stamp the body with `_demo` / `_demoEventType` / `_note` markers; those
// are sample-side metadata, not Vanta-emitted entities.
const META_KEYS = new Set(['_demo', '_demoEventType', '_note', 'type']);

/**
 * Walk the top-level body keys to find the entity object. For a real
 * Vanta delivery the body is shaped like:
 *   { "questionnaire": { "id": "123" } }
 * — one non-meta key whose value is the entity object. Return its key
 * (the entity name) and the entity's id, both nullable.
 */
function extractEntityFromBody(event) {
  if (!event || typeof event !== 'object') return null;
  for (const [key, value] of Object.entries(event)) {
    if (META_KEYS.has(key)) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const id = value.id || value.uuid || value.uniqueId
              || value.requestId || value.decisionId || null;
      return { key, id };
    }
  }
  return null;
}

/**
 * Derive a usable event-type string. Priority:
 *   1. Demo replay marker (`_demoEventType` on the body)
 *   2. Future-proof: `event.type` in case Vanta starts emitting it
 *   3. Inferred entity family (e.g. `v1.questionnaire.*`) — we know the
 *      entity but not the lifecycle stage, marked with `.*`
 *   4. null when we can't tell anything
 *
 * Used by both the receiver (ring-buffer display) and the forward path
 * (EVENT_HINTS lookup). Centralized so both render the same value.
 */
function deriveEventType(event) {
  if (event && typeof event === 'object') {
    if (typeof event._demoEventType === 'string') return event._demoEventType;
    if (typeof event.type === 'string') return event.type;
    const entity = extractEntityFromBody(event);
    if (entity) {
      // Trust-center is special: the entity key is `accessRequest` but
      // the canonical event family is `v1.trust-center.access-request.*`.
      // Map known entities to canonical event families for the display.
      const ENTITY_TO_FAMILY = {
        questionnaire:  'v1.questionnaire.*',
        accessRequest:  'v1.trust-center.access-request.*',
        vendorDecision: 'v1.vendor.decision.*'
      };
      return ENTITY_TO_FAMILY[entity.key] || `v1.${entity.key}.*`;
    }
  }
  return null;
}

function transformEventToPayload(event) {
  const vantaEvent = deriveEventType(event) || 'unknown';
  const exactHint = EVENT_HINTS[vantaEvent];
  const familyPrefix = FAMILY_SUMMARY_PREFIX[vantaEvent];

  // Pick the most specific hint available. exact > family > default.
  const summaryPrefix = exactHint?.summaryPrefix
    || familyPrefix
    || DEFAULT_HINT.summaryPrefix;
  const workflowHints = exactHint?.workflowHints
    || DEFAULT_HINT.workflowHints;

  const entity = extractEntityFromBody(event);
  const vantaObject = {
    // Prefer the entity key (real Vanta body shape) over the event-type
    // prefix (which is only meaningful when type is explicit).
    type: entity?.key || vantaEvent.split('.')[0] || 'unknown',
    id:   entity?.id  || null
  };

  const summarySuffix = vantaObject.id ? ` · ${vantaObject.id}` : '';
  const summary = `${summaryPrefix}${summarySuffix}`;

  return {
    source: 'vanta',
    vantaEvent,
    vantaObject,
    summary,
    workflowHints: [...workflowHints],
    rawEvent: event
  };
}

/**
 * Forward a verified event downstream. Returns a structured result so the
 * receiver can record per-forward outcome on the ring-buffer entry. Does
 * NOT throw — failures are captured in the result and the webhook still
 * acks 200 to Vanta (retries don't help if our destination is down).
 */
async function forwardEvent(event) {
  try {
    const payload = transformEventToPayload(event);
    const recorded = receivePayload(payload);
    logger.info('Webhook event forwarded to Workflow Sink', {
      vantaEvent: payload.vantaEvent,
      payloadId: recorded.id,
      vantaObjectType: payload.vantaObject.type
    });
    return {
      ok: true,
      payloadId: recorded.id,
      summary: recorded.summary,
      error: null
    };
  } catch (err) {
    logger.error('Webhook forward to Workflow Sink failed', { error: err.message });
    return {
      ok: false,
      payloadId: null,
      summary: null,
      error: err.message
    };
  }
}

module.exports = {
  forwardEvent,
  transformEventToPayload,
  deriveEventType,
  extractEntityFromBody,
  EVENT_HINTS,
  DEFAULT_HINT
};
