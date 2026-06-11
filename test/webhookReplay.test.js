const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const replay = require('../src/webhooks/webhookReplay');
const eventStore = require('../src/webhooks/eventStore');
const mockWorkflowSink = require('../src/mockWorkflowSink');

const TEST_SECRET = 'whsec_dGVzdHNlY3JldA==';

let prevSecret;
beforeEach(() => {
  replay._reset();
  eventStore._reset();
  mockWorkflowSink._reset();
  prevSecret = process.env.VANTA_WEBHOOK_SECRET;
});
afterEach(() => {
  if (prevSecret === undefined) delete process.env.VANTA_WEBHOOK_SECRET;
  else process.env.VANTA_WEBHOOK_SECRET = prevSecret;
});

describe('runReplay — secret unconfigured', () => {
  test('returns 503 with clear error when VANTA_WEBHOOK_SECRET is unset', async () => {
    delete process.env.VANTA_WEBHOOK_SECRET;
    const result = await replay.runReplay();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.statusCode, 503);
    assert.match(result.error, /secret unconfigured/);
  });

  test('no event recorded when secret is unset (no buffer pollution)', async () => {
    delete process.env.VANTA_WEBHOOK_SECRET;
    await replay.runReplay();
    assert.strictEqual(eventStore.getEvents().length, 0);
    assert.strictEqual(mockWorkflowSink.loadPayloads().length, 0);
  });
});

describe('runReplay — fresh replay (the default path)', () => {
  beforeEach(() => { process.env.VANTA_WEBHOOK_SECRET = TEST_SECRET; });

  test('routes through the real receiver pipeline (verified + forwarded)', async () => {
    const result = await replay.runReplay();

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.forwarded, true);
    assert.strictEqual(result.deduped, false);
    assert.ok(result.svixId);
    assert.ok(result.eventType);

    // Ring buffer entry — same shape as a real Vanta delivery.
    const events = eventStore.getEvents();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].verification.ok, true);
    assert.strictEqual(events[0].dedupe.status, 'fresh');
    assert.strictEqual(events[0].processingStatus, 'forwarded');
    assert.strictEqual(events[0].svixId, result.svixId);

    // Workflow Sink payload landed.
    const payloads = mockWorkflowSink.loadPayloads();
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].vantaEvent, result.eventType);
  });

  test('consecutive replays cycle through the SAMPLES catalog', async () => {
    const seen = [];
    for (let i = 0; i < replay.SAMPLES.length + 1; i++) {
      const r = await replay.runReplay();
      seen.push(r.eventType);
    }
    // First N match SAMPLES order; (N+1)th wraps to SAMPLES[0].
    for (let i = 0; i < replay.SAMPLES.length; i++) {
      assert.strictEqual(seen[i], replay.SAMPLES[i]._demoEventType);
    }
    assert.strictEqual(seen[replay.SAMPLES.length], replay.SAMPLES[0]._demoEventType);
  });

  test('each fresh replay gets a distinct svix-id', async () => {
    const a = await replay.runReplay();
    const b = await replay.runReplay();
    const c = await replay.runReplay();
    const ids = [a.svixId, b.svixId, c.svixId];
    assert.strictEqual(new Set(ids).size, 3, 'three distinct svix-ids');
  });

  test('each fresh replay produces a distinct Workflow Sink payload', async () => {
    await replay.runReplay();
    await replay.runReplay();
    await replay.runReplay();
    assert.strictEqual(mockWorkflowSink.loadPayloads().length, 3);
  });
});

describe('runReplay — dedupe-test mode', () => {
  beforeEach(() => { process.env.VANTA_WEBHOOK_SECRET = TEST_SECRET; });

  test('returns 400 with clear error when no prior replay exists', async () => {
    const result = await replay.runReplay({ dedupeTest: true });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.statusCode, 400);
    assert.match(result.error, /no prior replay/);
  });

  test('reuses the last replay svix-id and hits the dedupe path', async () => {
    const fresh = await replay.runReplay();
    const dup   = await replay.runReplay({ dedupeTest: true });

    assert.strictEqual(dup.ok, true);
    assert.strictEqual(dup.statusCode, 200);
    assert.strictEqual(dup.deduped, true);
    assert.strictEqual(dup.svixId, fresh.svixId, 'same svix-id as the fresh replay');
  });

  test('dedupe-test does NOT create a duplicate Workflow Sink payload', async () => {
    await replay.runReplay();
    await replay.runReplay({ dedupeTest: true });

    const payloads = mockWorkflowSink.loadPayloads();
    assert.strictEqual(payloads.length, 1, 'only the fresh replay produced a payload');
  });

  test('dedupe-test does record the duplicate in the ring buffer (audit-visible)', async () => {
    await replay.runReplay();
    await replay.runReplay({ dedupeTest: true });

    const events = eventStore.getEvents();
    assert.strictEqual(events.length, 2);
    // Newest first — dedupe entry at index 0.
    assert.strictEqual(events[0].dedupe.status, 'duplicate');
    assert.strictEqual(events[0].processingStatus, 'deduped');
    assert.strictEqual(events[1].dedupe.status, 'fresh');
  });

  test('a subsequent fresh replay updates the last svix-id (so dedupe-test follows it)', async () => {
    const first  = await replay.runReplay();
    const second = await replay.runReplay();
    const dup    = await replay.runReplay({ dedupeTest: true });
    assert.strictEqual(dup.svixId, second.svixId, 'dedupe-test follows the most recent fresh svix-id');
    assert.notStrictEqual(dup.svixId, first.svixId);
  });
});

describe('runReplay — demo sample markers', () => {
  beforeEach(() => { process.env.VANTA_WEBHOOK_SECRET = TEST_SECRET; });

  test('every SAMPLE carries _demo + _demoEventType (real v1.*) + _note', () => {
    for (const sample of replay.SAMPLES) {
      assert.strictEqual(sample._demo, true, sample._demoEventType + ' missing _demo flag');
      assert.match(sample._demoEventType, /^v1\./, sample._demoEventType + ' is not a v1.* event type');
      assert.match(sample._note, /[Dd]emo sample/, sample._demoEventType + ' missing _note');
    }
  });

  test('every SAMPLE body carries a real Vanta-shaped entity (questionnaire / accessRequest / vendorDecision)', () => {
    const validEntities = new Set(['questionnaire', 'accessRequest', 'vendorDecision']);
    for (const sample of replay.SAMPLES) {
      const entityKey = Object.keys(sample).find(k => validEntities.has(k));
      assert.ok(entityKey, sample._demoEventType + ' body has no recognized entity key');
      assert.ok(sample[entityKey].id, entityKey + ' object missing id field');
    }
  });

  test('the rawEvent forwarded to Workflow Sink retains the _demo marker', async () => {
    await replay.runReplay();
    const payload = mockWorkflowSink.loadPayloads()[0];
    assert.strictEqual(payload.rawEvent._demo, true);
    assert.match(payload.rawEvent._note, /demo/i);
  });

  test('no outbound Vanta calls happen during a replay', async () => {
    // The replay path imports svix and the receiver — nothing else. There
    // is no way to call buildClient/manageClient from this module's surface.
    // This test is documentation: replays sign locally and dispatch
    // in-process. If a future change adds a Vanta call here, that's a
    // structural problem to flag.
    const replayModule = require('../src/webhooks/webhookReplay');
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'webhooks', 'webhookReplay.js'),
      'utf-8'
    );
    assert.ok(!src.includes('buildClient'),  'replay must not import buildClient');
    assert.ok(!src.includes('manageClient'), 'replay must not import manageClient');
    assert.ok(!src.includes('vantaClient'),  'replay must not import vantaClient');
    assert.ok(replayModule, 'module loads');
  });
});
