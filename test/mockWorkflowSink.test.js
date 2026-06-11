const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const mockWorkflowSink = require('../src/mockWorkflowSink');

beforeEach(() => mockWorkflowSink._reset());

function makePayload(overrides = {}) {
  return {
    source: 'vanta',
    vantaEvent: 'v1.questionnaire.created',
    vantaObject: { type: 'questionnaire', id: 'qst-1' },
    summary: 'Questionnaire created · qst-1',
    workflowHints: ['Review in Vanta', 'Route to GRC owner'],
    rawEvent: { questionnaire: { id: 'qst-1' } },
    ...overrides
  };
}

describe('mockWorkflowSink.receivePayload', () => {
  test('assigns a monotonically incrementing id', () => {
    const a = mockWorkflowSink.receivePayload(makePayload());
    const b = mockWorkflowSink.receivePayload(makePayload());
    const c = mockWorkflowSink.receivePayload(makePayload());
    assert.strictEqual(a.id, 'payload-0001');
    assert.strictEqual(b.id, 'payload-0002');
    assert.strictEqual(c.id, 'payload-0003');
  });

  test('preserves all payload fields plus adds id + receivedAt', () => {
    const out = mockWorkflowSink.receivePayload(makePayload({
      summary: 'Specific summary',
      vantaEvent: 'v1.questionnaire.export-failed'
    }));
    assert.strictEqual(out.summary, 'Specific summary');
    assert.strictEqual(out.vantaEvent, 'v1.questionnaire.export-failed');
    assert.strictEqual(out.source, 'vanta');
    assert.deepStrictEqual(out.workflowHints, ['Review in Vanta', 'Route to GRC owner']);
    assert.ok(out.id);
    assert.ok(out.receivedAt);
  });
});

describe('mockWorkflowSink.loadPayloads', () => {
  test('returns newest first', () => {
    mockWorkflowSink.receivePayload(makePayload({ summary: 'first' }));
    mockWorkflowSink.receivePayload(makePayload({ summary: 'second' }));
    mockWorkflowSink.receivePayload(makePayload({ summary: 'third' }));
    const list = mockWorkflowSink.loadPayloads();
    assert.deepStrictEqual(list.map(p => p.summary), ['third', 'second', 'first']);
  });

  test('returns a defensive copy — caller mutations do not affect the store', () => {
    mockWorkflowSink.receivePayload(makePayload({ summary: 'original' }));
    const snapshot = mockWorkflowSink.loadPayloads();
    snapshot[0].summary = 'mutated';
    snapshot.push({ id: 'injected' });

    const fresh = mockWorkflowSink.loadPayloads();
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(fresh[0].summary, 'original');
  });

  test('caps at MAX_PAYLOADS (oldest dropped)', () => {
    for (let i = 0; i < mockWorkflowSink.MAX_PAYLOADS + 3; i++) {
      mockWorkflowSink.receivePayload(makePayload({ summary: `s-${i}` }));
    }
    const list = mockWorkflowSink.loadPayloads();
    assert.strictEqual(list.length, mockWorkflowSink.MAX_PAYLOADS);
    // Newest first — most recent should be at index 0.
    assert.strictEqual(list[0].summary, `s-${mockWorkflowSink.MAX_PAYLOADS + 2}`);
  });
});

describe('mockWorkflowSink._reset', () => {
  test('clears payloads and resets counter', () => {
    mockWorkflowSink.receivePayload(makePayload());
    mockWorkflowSink.receivePayload(makePayload());
    mockWorkflowSink._reset();
    assert.strictEqual(mockWorkflowSink.loadPayloads().length, 0);
    // First payload after reset should be payload-0001 again.
    const fresh = mockWorkflowSink.receivePayload(makePayload());
    assert.strictEqual(fresh.id, 'payload-0001');
  });
});
