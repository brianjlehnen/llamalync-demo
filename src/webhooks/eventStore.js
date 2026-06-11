/**
 * In-memory store for received Vanta webhook events.
 *
 * Two structures:
 *   - `events` — a ring buffer of the last N delivery records, newest first.
 *     Each entry captures enough context for an SA to triage what happened
 *     (svix-id, timestamp, event type, body preview, verification + dedupe
 *     outcome, processing status) WITHOUT leaking the signature header or
 *     full request headers (which can carry other tokens).
 *   - `seenIds` — a bounded set of svix-id values we've already processed,
 *     for deduping at-least-once redeliveries. Cap is conservative because
 *     Vanta's retry window is ~24h and event volume is low; oldest ids fall
 *     out FIFO when the cap is reached.
 *
 * Lives in-memory only — resets on restart, mirrors the request-log shape.
 * Persistence is out of scope for the demo.
 */

const MAX_EVENTS = 50;
const MAX_SEEN_IDS = 1000;
const BODY_PREVIEW_CHARS = 500;

let events = [];
const seenIds = new Set();
// Insertion-order array shadowing `seenIds` so we can evict the OLDEST id
// when we hit MAX_SEEN_IDS. Set itself preserves insertion order, but
// evicting the first member without iterating all keys is tidier this way.
let seenIdOrder = [];

function recordEvent(entry) {
  events.unshift(entry);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

function getEvents() {
  // Defensive copy so callers (dashboard render, /webhooks.json) can't
  // mutate the buffer through a held reference.
  return events.map(e => ({ ...e }));
}

function hasSeenId(svixId) {
  return seenIds.has(svixId);
}

function markSeen(svixId) {
  if (seenIds.has(svixId)) return;
  seenIds.add(svixId);
  seenIdOrder.push(svixId);
  while (seenIdOrder.length > MAX_SEEN_IDS) {
    const evicted = seenIdOrder.shift();
    seenIds.delete(evicted);
  }
}

function previewBody(rawBody) {
  if (typeof rawBody !== 'string') return null;
  if (rawBody.length <= BODY_PREVIEW_CHARS) return rawBody;
  return rawBody.slice(0, BODY_PREVIEW_CHARS) + '…';
}

function _reset() {
  events = [];
  seenIds.clear();
  seenIdOrder = [];
}

module.exports = {
  recordEvent,
  getEvents,
  hasSeenId,
  markSeen,
  previewBody,
  _reset,
  MAX_EVENTS,
  MAX_SEEN_IDS,
  BODY_PREVIEW_CHARS
};
