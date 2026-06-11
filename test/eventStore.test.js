const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const eventStore = require('../src/webhooks/eventStore');

beforeEach(() => eventStore._reset());

describe('eventStore — record + retrieve', () => {
  test('recordEvent + getEvents returns newest first', () => {
    eventStore.recordEvent({ svixId: 'a' });
    eventStore.recordEvent({ svixId: 'b' });
    eventStore.recordEvent({ svixId: 'c' });
    const events = eventStore.getEvents();
    assert.deepStrictEqual(events.map(e => e.svixId), ['c', 'b', 'a']);
  });

  test('ring buffer caps at MAX_EVENTS (oldest dropped)', () => {
    for (let i = 0; i < eventStore.MAX_EVENTS + 5; i++) {
      eventStore.recordEvent({ svixId: `id-${i}` });
    }
    const events = eventStore.getEvents();
    assert.strictEqual(events.length, eventStore.MAX_EVENTS);
    // Newest first — last id pushed is first.
    assert.strictEqual(events[0].svixId, `id-${eventStore.MAX_EVENTS + 4}`);
  });

  test('getEvents returns a defensive copy (caller mutation does not leak)', () => {
    eventStore.recordEvent({ svixId: 'a', tag: 'original' });
    const snapshot = eventStore.getEvents();
    snapshot[0].tag = 'mutated';
    snapshot.push({ svixId: 'injected' });

    const fresh = eventStore.getEvents();
    assert.strictEqual(fresh[0].tag, 'original');
    assert.strictEqual(fresh.length, 1);
  });
});

describe('eventStore — dedupe by svix-id', () => {
  test('hasSeenId returns false before markSeen', () => {
    assert.strictEqual(eventStore.hasSeenId('msg_001'), false);
  });

  test('hasSeenId returns true after markSeen', () => {
    eventStore.markSeen('msg_001');
    assert.strictEqual(eventStore.hasSeenId('msg_001'), true);
  });

  test('markSeen is idempotent (no error on re-mark)', () => {
    eventStore.markSeen('msg_001');
    eventStore.markSeen('msg_001');
    assert.strictEqual(eventStore.hasSeenId('msg_001'), true);
  });

  test('dedupe set evicts oldest svix-id at MAX_SEEN_IDS', () => {
    for (let i = 0; i < eventStore.MAX_SEEN_IDS + 3; i++) {
      eventStore.markSeen(`msg-${i}`);
    }
    // The first 3 should have been evicted.
    assert.strictEqual(eventStore.hasSeenId('msg-0'), false);
    assert.strictEqual(eventStore.hasSeenId('msg-1'), false);
    assert.strictEqual(eventStore.hasSeenId('msg-2'), false);
    // The most recent should still be there.
    assert.strictEqual(
      eventStore.hasSeenId(`msg-${eventStore.MAX_SEEN_IDS + 2}`),
      true
    );
  });
});

describe('eventStore — body preview truncation', () => {
  test('short body returns unchanged', () => {
    assert.strictEqual(eventStore.previewBody('hello'), 'hello');
  });

  test('body exactly at BODY_PREVIEW_CHARS returns unchanged', () => {
    const exactly = 'x'.repeat(eventStore.BODY_PREVIEW_CHARS);
    assert.strictEqual(eventStore.previewBody(exactly), exactly);
  });

  test('long body is truncated with ellipsis', () => {
    const long = 'x'.repeat(eventStore.BODY_PREVIEW_CHARS + 50);
    const preview = eventStore.previewBody(long);
    assert.strictEqual(preview.length, eventStore.BODY_PREVIEW_CHARS + 1);
    assert.ok(preview.endsWith('…'));
  });

  test('non-string returns null', () => {
    assert.strictEqual(eventStore.previewBody(null), null);
    assert.strictEqual(eventStore.previewBody(undefined), null);
    assert.strictEqual(eventStore.previewBody(123), null);
    assert.strictEqual(eventStore.previewBody(Buffer.from('x')), null);
  });
});

describe('eventStore — _reset', () => {
  test('clears events and dedupe set', () => {
    eventStore.recordEvent({ svixId: 'a' });
    eventStore.markSeen('a');
    eventStore._reset();
    assert.strictEqual(eventStore.getEvents().length, 0);
    assert.strictEqual(eventStore.hasSeenId('a'), false);
  });
});
