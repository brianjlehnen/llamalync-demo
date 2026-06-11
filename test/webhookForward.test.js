const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  forwardEvent,
  transformEventToPayload,
  deriveEventType,
  extractEntityFromBody,
  EVENT_HINTS,
  DEFAULT_HINT
} = require('../src/webhooks/webhookForward');
const mockWorkflowSink = require('../src/mockWorkflowSink');

beforeEach(() => mockWorkflowSink._reset());

// Body shapes mirror what Vanta actually delivers (verified empirically
// 2026-05-19): entity object at the root, no `type` field. Demo replays
// add `_demoEventType` so the EVENT_HINTS lookup matches.
function questionnaireBody(eventType, extras = {}) {
  return {
    _demo: true,
    _demoEventType: eventType,
    questionnaire: { id: 'qst-1', ...extras }
  };
}
function accessRequestBody(eventType, extras = {}) {
  return {
    _demo: true,
    _demoEventType: eventType,
    accessRequest: { id: 'req-1', ...extras }
  };
}
function vendorDecisionBody(eventType, extras = {}) {
  return {
    _demo: true,
    _demoEventType: eventType,
    vendorDecision: { id: 'vd-1', ...extras }
  };
}

describe('transformEventToPayload — neutral payload shape', () => {
  test('payload shape: source, vantaEvent, vantaObject, summary, workflowHints, rawEvent', () => {
    const payload = transformEventToPayload(questionnaireBody('v1.questionnaire.created'));
    assert.strictEqual(payload.source, 'vanta');
    assert.strictEqual(payload.vantaEvent, 'v1.questionnaire.created');
    assert.deepStrictEqual(payload.vantaObject, { type: 'questionnaire', id: 'qst-1' });
    assert.ok(typeof payload.summary === 'string' && payload.summary.length > 0);
    assert.ok(Array.isArray(payload.workflowHints) && payload.workflowHints.length > 0);
    assert.ok(payload.rawEvent);
  });

  test('payload has no severity field (priority belongs to the downstream system)', () => {
    const payload = transformEventToPayload(questionnaireBody('v1.questionnaire.export-failed'));
    assert.strictEqual(payload.severity, undefined);
    assert.strictEqual('severity' in payload, false);
  });

  test('payload has no title field (replaced by summary)', () => {
    const payload = transformEventToPayload(questionnaireBody('v1.questionnaire.created'));
    assert.strictEqual(payload.title, undefined);
    assert.strictEqual('title' in payload, false);
  });
});

describe('transformEventToPayload — real Vanta v1.* event types via _demoEventType', () => {
  test('v1.questionnaire.export-failed → export-failed summary + workflow hints', () => {
    const payload = transformEventToPayload(questionnaireBody('v1.questionnaire.export-failed'));
    assert.strictEqual(payload.vantaEvent, 'v1.questionnaire.export-failed');
    assert.match(payload.summary, /export failed/i);
    assert.ok(payload.workflowHints.some(h => /re-run|escalate/i.test(h)));
  });

  test('v1.questionnaire.created → reviewer hint', () => {
    const payload = transformEventToPayload(questionnaireBody('v1.questionnaire.created'));
    assert.ok(payload.workflowHints.some(h => /reviewer/i.test(h)));
  });

  test('v1.trust-center.access-request.received → approve-or-deny / SLA hint', () => {
    const payload = transformEventToPayload(accessRequestBody('v1.trust-center.access-request.received'));
    assert.match(payload.summary, /access request received/i);
    assert.ok(payload.workflowHints.some(h => /approve or deny|SLA/i.test(h)));
  });

  test('v1.vendor.decision.created → vendor decision summary', () => {
    const payload = transformEventToPayload(vendorDecisionBody('v1.vendor.decision.created'));
    assert.match(payload.summary, /vendor decision/i);
    assert.ok(payload.workflowHints.length >= 2);
  });

  test('every EVENT_HINTS entry has summaryPrefix + workflowHints', () => {
    for (const [eventType, hint] of Object.entries(EVENT_HINTS)) {
      assert.ok(hint.summaryPrefix, `${eventType} missing summaryPrefix`);
      assert.ok(Array.isArray(hint.workflowHints) && hint.workflowHints.length > 0,
        `${eventType} missing workflowHints`);
      assert.strictEqual(hint.severity, undefined, `${eventType} should not carry severity`);
    }
  });

  test('every EVENT_HINTS key starts with v1. (matches Vanta catalog naming)', () => {
    for (const eventType of Object.keys(EVENT_HINTS)) {
      assert.match(eventType, /^v1\./, `${eventType} does not match the v1.* naming convention`);
    }
  });

  test('workflowHints arrays are exposed as plain mutable copies on the payload', () => {
    // Internal EVENT_HINTS entries are frozen; the transform must clone so a
    // downstream consumer can append/mutate without corrupting the catalog.
    const payload = transformEventToPayload(questionnaireBody('v1.questionnaire.created'));
    assert.doesNotThrow(() => payload.workflowHints.push('Custom hint from downstream'));
    // Catalog entry untouched.
    assert.ok(EVENT_HINTS['v1.questionnaire.created'].workflowHints.length < payload.workflowHints.length);
  });
});

describe('transformEventToPayload — real Vanta delivery (no event type in payload)', () => {
  // The empirically observed shape from a live Vanta delivery on 2026-05-19:
  // body = {"questionnaire": {"id": "123"}} — no type, no envelope.

  test('real-shape body without _demoEventType uses default workflow hints', () => {
    const realBody = { questionnaire: { id: '123' } };
    const payload = transformEventToPayload(realBody);
    assert.deepStrictEqual(payload.workflowHints, [...DEFAULT_HINT.workflowHints]);
  });

  test('vantaObject populated from entity key + id even without event type', () => {
    const realBody = { questionnaire: { id: '123' } };
    const payload = transformEventToPayload(realBody);
    assert.strictEqual(payload.vantaObject.type, 'questionnaire');
    assert.strictEqual(payload.vantaObject.id, '123');
    // Summary carries the id even when we don't know the lifecycle stage.
    assert.match(payload.summary, /123/);
  });

  test('summary uses family-level phrasing when only entity is known', () => {
    const payload = transformEventToPayload({ questionnaire: { id: '123' } });
    assert.match(payload.summary, /questionnaire event received from vanta/i);
  });

  test('vantaEvent is the entity family wildcard when type is unknown', () => {
    const payload = transformEventToPayload({ questionnaire: { id: '123' } });
    assert.strictEqual(payload.vantaEvent, 'v1.questionnaire.*');
  });

  test('access-request entity key maps to its canonical event family', () => {
    const payload = transformEventToPayload({ accessRequest: { id: 'req-1' } });
    assert.strictEqual(payload.vantaEvent, 'v1.trust-center.access-request.*');
  });

  test('vendor-decision entity key maps to its canonical event family', () => {
    const payload = transformEventToPayload({ vendorDecision: { id: 'vd-1' } });
    assert.strictEqual(payload.vantaEvent, 'v1.vendor.decision.*');
  });
});

describe('transformEventToPayload — forward-compat: if Vanta ever adds event.type', () => {
  test('event.type wins over entity inference when no _demoEventType', () => {
    const payload = transformEventToPayload({
      type: 'v1.questionnaire.created',
      questionnaire: { id: 'qst-1' }
    });
    assert.strictEqual(payload.vantaEvent, 'v1.questionnaire.created');
    assert.ok(payload.workflowHints.some(h => /reviewer/i.test(h)));
  });

  test('_demoEventType wins over event.type (demo path takes precedence)', () => {
    const payload = transformEventToPayload({
      type: 'v1.questionnaire.deleted',
      _demoEventType: 'v1.questionnaire.export-failed',
      questionnaire: { id: 'qst-1' }
    });
    assert.strictEqual(payload.vantaEvent, 'v1.questionnaire.export-failed');
    assert.match(payload.summary, /export failed/i);
  });
});

describe('transformEventToPayload — degenerate inputs', () => {
  test('null event returns a defaulted payload without throwing', () => {
    assert.doesNotThrow(() => transformEventToPayload(null));
    const payload = transformEventToPayload(null);
    assert.strictEqual(payload.vantaEvent, 'unknown');
    assert.deepStrictEqual(payload.workflowHints, [...DEFAULT_HINT.workflowHints]);
  });

  test('empty object → unknown event + null id', () => {
    const payload = transformEventToPayload({});
    assert.strictEqual(payload.vantaEvent, 'unknown');
    assert.strictEqual(payload.vantaObject.id, null);
  });

  test('only meta fields, no entity → unknown', () => {
    const payload = transformEventToPayload({ _demo: true, _note: 'orphan' });
    assert.strictEqual(payload.vantaEvent, 'unknown');
  });
});

describe('extractEntityFromBody', () => {
  test('finds the questionnaire entity at the root', () => {
    const entity = extractEntityFromBody({ questionnaire: { id: 'qst-1' } });
    assert.strictEqual(entity.key, 'questionnaire');
    assert.strictEqual(entity.id, 'qst-1');
  });

  test('skips meta keys when scanning', () => {
    const entity = extractEntityFromBody({
      _demo: true,
      _demoEventType: 'v1.questionnaire.created',
      _note: 'sample',
      type: 'v1.questionnaire.created',
      questionnaire: { id: 'qst-1' }
    });
    assert.strictEqual(entity.key, 'questionnaire');
    assert.strictEqual(entity.id, 'qst-1');
  });

  test('falls back to uuid / uniqueId / requestId / decisionId for the entity id', () => {
    assert.strictEqual(extractEntityFromBody({ thing: { uuid: 'u-1' } }).id, 'u-1');
    assert.strictEqual(extractEntityFromBody({ thing: { uniqueId: 'unq-1' } }).id, 'unq-1');
    assert.strictEqual(extractEntityFromBody({ accessRequest: { requestId: 'req-1' } }).id, 'req-1');
    assert.strictEqual(extractEntityFromBody({ vendorDecision: { decisionId: 'd-1' } }).id, 'd-1');
  });

  test('null / undefined / non-object returns null', () => {
    assert.strictEqual(extractEntityFromBody(null), null);
    assert.strictEqual(extractEntityFromBody(undefined), null);
    assert.strictEqual(extractEntityFromBody('string'), null);
  });
});

describe('deriveEventType — priority order', () => {
  test('1. _demoEventType wins over everything', () => {
    assert.strictEqual(
      deriveEventType({ _demoEventType: 'v1.questionnaire.created', type: 'X', questionnaire: {} }),
      'v1.questionnaire.created'
    );
  });

  test('2. event.type wins when no _demoEventType', () => {
    assert.strictEqual(
      deriveEventType({ type: 'v1.questionnaire.created', questionnaire: {} }),
      'v1.questionnaire.created'
    );
  });

  test('3. entity family wildcard when no explicit type', () => {
    assert.strictEqual(deriveEventType({ questionnaire: {} }), 'v1.questionnaire.*');
    assert.strictEqual(deriveEventType({ accessRequest: {} }), 'v1.trust-center.access-request.*');
    assert.strictEqual(deriveEventType({ vendorDecision: {} }), 'v1.vendor.decision.*');
  });

  test('4. null when nothing identifiable', () => {
    assert.strictEqual(deriveEventType({}), null);
    assert.strictEqual(deriveEventType(null), null);
  });
});

describe('forwardEvent — integration with mockWorkflowSink', () => {
  test('forwards a real-shape Vanta delivery (no type) with sensible defaults', async () => {
    const result = await forwardEvent({ questionnaire: { id: '123' } });
    assert.strictEqual(result.ok, true);
    assert.ok(result.payloadId);
    const payload = mockWorkflowSink.loadPayloads()[0];
    assert.strictEqual(payload.vantaEvent, 'v1.questionnaire.*');
    assert.strictEqual(payload.vantaObject.id, '123');
    assert.strictEqual(payload.vantaObject.type, 'questionnaire');
  });

  test('forwards a demo replay event with full polish', async () => {
    const result = await forwardEvent({
      _demoEventType: 'v1.questionnaire.export-failed',
      questionnaire: { id: 'qst-7' }
    });
    assert.strictEqual(result.ok, true);
    assert.match(result.summary, /export failed/i);
    const payload = mockWorkflowSink.loadPayloads()[0];
    assert.strictEqual(payload.vantaEvent, 'v1.questionnaire.export-failed');
    assert.match(payload.summary, /export failed/i);
  });

  test('rawEvent preserved verbatim on the forwarded payload', async () => {
    const event = {
      _demo: true,
      _demoEventType: 'v1.vendor.decision.created',
      _note: 'sample',
      vendorDecision: { id: 'vd-1', vendor: 'Stripe' }
    };
    await forwardEvent(event);
    const payload = mockWorkflowSink.loadPayloads()[0];
    assert.deepStrictEqual(payload.rawEvent, event);
  });
});
