# Webhooks / Workflow Sink — design spec

**Destination name:** Workflow Sink (a downstream compliance workflow system — Jira, Linear, Slack, Salesforce, Coupa, or a homegrown GRC queue). Note the deliberate omission of PagerDuty / Opsgenie: the events confirmed for this scenario are workflow-shaped, not operational-alert-shaped.

**Thesis.** Webhooks are not a replacement for reconciliation; they are a real-time workflow trigger for the Vanta events the tenant emits.

---

## 0. The architectural twist

**The other four scenarios are LlamaLync-as-publisher (pull from source, push to Vanta). This one is Vanta-as-publisher (Vanta pushes events to LlamaLync, which routes them downstream).**

| | Personnel / Risk / Devices / Evidence | Webhooks |
|---|---|---|
| **Trigger** | LlamaLync polls source on a cron or operator click | Vanta pushes when state changes in the tenant |
| **Direction** | Source → LlamaLync → Vanta | Vanta → LlamaLync → Workflow Sink destination |
| **Auth** | OAuth client_credentials to Vanta (Build / Manage app) | HMAC signature on each inbound request (Svix-based) |
| **Sync cadence** | Hourly / on-demand | Real-time, event-driven |
| **Source of truth** | The bespoke source system | The Vanta tenant |
| **Vanta surface** | `/v1/resources/{type}` PUT, `/v1/risk-scenarios` POST/PATCH, `/v1/documents/{slot}/uploads` | `POST /webhooks/vanta` — the integration exposes the endpoint, Vanta calls it |

The receive-and-route shape is materially different from the four poll-and-push scenarios. The event types confirmed for this scenario (questionnaires, trust-center access requests, vendor decisions) are **workflow events** — they land in a program-management queue, not an on-call rotation. Vanta's public docs do not publish a fixed catalog, so always check *Settings → Webhooks* in your tenant against what is actually available before assuming operational events are emitted.

### Why this matters

The other four LlamaLync scenarios show how to push data INTO Vanta. Webhooks are the inverse — Vanta emits workflow events, LlamaLync verifies and dedupes them, then transforms them into whatever payload the downstream compliance workflow system expects. The pattern is the same regardless of the destination: receive, verify the signature, dedupe by id, transform, forward. LlamaLync demonstrates this with a **Workflow Sink** stand-in, but in a real integration the destination is whatever the GRC, sales, or procurement team already uses — Jira, Slack, Salesforce, Coupa, or a homegrown GRC queue.

The **polling caveat** also matters: webhooks supplement scheduled reconciliation, they do not replace it (see §7). Especially important because Vanta's webhook catalog does not appear to emit operational compliance events (test failures, control state changes) — only workflow events — so operational alerting still requires polling.

---

## 1. Audience archetypes + pain

The events Vanta actually emits target **three distinct audiences**, not one.

### 1a. GRC / compliance program manager — *questionnaire workflow*

**Events:** `v1.questionnaire.{created, deleted, status-changed, export-completed, export-failed}`.

**Today's pain:** when a customer or auditor sends a security questionnaire, it lands in an email alias or a shared inbox. Tracking happens in a spreadsheet, the GRC team's actual queue is Jira or Linear. Status changes and export deliveries are tracked manually — easy to lose, easy to miss the export-failed case.

**The original ask:**
> *"Every time a new questionnaire comes in or an export breaks, I want it as a ticket in our GRC board. We work in Jira; we don't work in Vanta's UI."*

**Webhook fix:** new questionnaire → forward a payload with the questionnaire id pre-populated; the workflow system maps that to a Jira/Linear card. Status change → forward an update payload the destination correlates. Export-failed → the workflow hints flag the failure so the destination can route it to whoever owns export recovery.

### 1b. Sales engineering / Customer success / Security leadership — *trust-center access requests*

**Events:** `v1.trust-center.access-request.{received, approved, denied}`.

**Today's pain:** when a prospect on the marketing site hits *"Request access to our SOC 2 report"* on the trust center, that goes to an email alias. Someone — sometimes the AE, sometimes a security operator — eventually sees it and approves or denies. The approval cycle is hours to days. Prospects in active deal cycles notice.

**The original ask:**
> *"Our prospects shouldn't wait a day for our SOC 2 report. When the access request comes in, ping the AE in Slack with the requester's company and email, so they can approve in 30 seconds."*

**Webhook fix:** access-request.received → forward a payload carrying company + email + requested documents; the workflow system (Slack channel for the AE, Salesforce task, etc.) picks it up and starts the SLA clock. Approved/denied events forward update payloads the destination correlates for audit.

### 1c. Procurement / TPRM — *vendor decisions*

**Events:** `v1.vendor.decision.created`.

**Today's pain:** the security team approves or rejects vendors in Vanta. Procurement runs in a separate system (Coupa, Ariba, internal tool) that does not know about Vanta's decision until someone manually updates it.

**The original ask:**
> *"When security signs off on a vendor in Vanta, that decision should flow into procurement automatically. We shouldn't be re-typing approvals between two systems."*

**Webhook fix:** vendor.decision.created → procurement system gets the structured decision the moment it is recorded.

### Pain points the Webhooks scenario does NOT address

- **Operational compliance alerting.** For *"page me when a SOC 2 test fails"* or *"alert when a control review is overdue"*, polling `/v1/tests` / `/v1/controls` is the supported path. Vanta's webhook catalog does not appear to emit those operational events — confirm against the tenant's `Settings → Webhooks` before relying on real-time delivery for them.
- **Source of truth.** The destination ticket is a derived artifact. Authoritative state lives in Vanta. The queue is not the source of truth.
- **Replay across full history.** Webhooks fire on state *changes* going forward. Yesterday's questionnaires do not arrive today just because the receiver was wired up. Periodic reconciliation fills that gap.

---

## 2. Mock destination system

**Module:** [`src/mockWorkflowSink/`](../../src/mockWorkflowSink/index.js)

**Source/destination inversion:** Unlike mockHris / mockCmdb / mockRiskRegister / mockEvidenceStore — which all *serve* data to LlamaLync — Workflow Sink *receives* data *from* LlamaLync's forward pipeline. There's no `mock-data/workflow-sink.json` fixture file. The store starts empty and fills as events arrive.

**Routes:**

```
GET  /mock-workflow-sink/payloads.json    — list of forwarded payloads, newest first
GET  /mock-workflow-sink/_meta.json       — count + breakdown by vantaObject family / vantaEvent
POST /mock-workflow-sink/reset             — clear the in-memory store
```

**Payload shape (deliberately neutral — LlamaLync makes no assumption about what the downstream workflow system expects):**

```js
{
  id:            'payload-0001',
  receivedAt:    '2026-05-19T...',
  source:        'vanta',
  vantaEvent:    'v1.questionnaire.created' | 'v1.questionnaire.*' | 'unknown',
  vantaObject:   { type: 'questionnaire', id: '123' },
  summary:       'Questionnaire created · 123',
  workflowHints: ['Review in Vanta', 'Route to GRC owner', ...],
  rawEvent:      { questionnaire: { id: '123' }, _demo?: true }
}
```

**No severity field — by design.** Jira priority, Slack color, Salesforce task urgency, Coupa workflow state, and an internal GRC queue's routing rules are all different. LlamaLync surfaces neutral `workflowHints` and lets the destination system map families to its own priority / routing taxonomy.

**Promotion path:** when LlamaLync deploys, /mock-workflow-sink deploys with it. For a real integration, swap [`receivePayload()`](../../src/mockWorkflowSink/index.js) in [`webhookForward.js`](../../src/webhooks/webhookForward.js) for an HTTP POST to the actual workflow API (Jira, Linear, Slack, Salesforce, Coupa, internal GRC queue, etc.). The transform layer (event → payload) stays unchanged; only the destination call changes.

---

## 3. Vanta API surface + security model

### Webhook delivery uses Svix (since 2025)

Vanta migrated outbound webhooks to [Svix](https://www.svix.com/) — a webhook-as-a-service provider that handles signing, retries, and delivery. Public docs: <https://developer.vanta.com/docs/webhooks>.

Each inbound request carries three headers:

| Header | Purpose |
|---|---|
| `svix-id` | Unique per delivery. **At-least-once delivery → use this as the dedupe key.** |
| `svix-timestamp` | Unix seconds. Used for replay-window enforcement. |
| `svix-signature` | HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`, prefixed `v1,…`. May contain multiple space-separated signatures for key rotation. |

Verification options:

- **Official `svix` library** (the LlamaLync choice — see [`webhookReceiver.js`](../../src/webhooks/webhookReceiver.js)). Handles header parsing, timestamp tolerance, multi-signature compare, constant-time HMAC. Adds one dep but the contract is non-trivial to hand-roll correctly.
- **Manual HMAC** — build the signed string, compute the HMAC, `timingSafeEqual`. Doable but error-prone; small mistakes (wrong delimiter, wrong base64 decoding of the secret, missing timestamp tolerance) all produce silent failures.

### At-least-once delivery — the dedupe contract

Vanta (via Svix) guarantees at-least-once delivery: if your endpoint returns a non-2xx or times out, the same event is retried later. The same `svix-id` may arrive twice.

**Right answer:** dedupe by `svix-id` in the consumer. LlamaLync keeps an in-memory `Set` of recently-seen ids (capacity 1000, FIFO eviction). When a duplicate arrives, the receiver acks `200 + deduped:true` (so Vanta stops retrying) but skips the forward step (so no duplicate Workflow Sink payload).

**Wrong answers:**

- Treat every delivery as fresh → duplicate payloads downstream, duplicate work items, queue fatigue.
- Reject duplicates with a non-2xx → Vanta keeps retrying forever.

### Event catalog is tenant-discovered, NOT publicly enumerated

Vanta's public webhook docs intentionally do not publish a definitive list of event types. The tenant determines which events are emitted; the canonical source is the Vanta dashboard's **Settings → Webhooks → Send Example** feature, which lets a tenant admin preview each available event type.

Verified empirically against a live tenant — the **v1.\*** catalog includes:

```
v1.questionnaire.{created, deleted, status-changed, export-completed, export-failed}
v1.trust-center.access-request.{received, approved, denied}
v1.vendor.decision.created
```

LlamaLync's [`EVENT_HINTS`](../../src/webhooks/webhookForward.js) lookup is keyed on these real names with `summaryPrefix` + `workflowHints` mappings; the [`SAMPLES`](../../src/webhooks/webhookReplay.js) catalog used by replay covers four representative events across the three entity families (questionnaire, trust-center access request, vendor decision).

**Do not overpromise:** demo samples carry `_demo: true` + a `_note` field explicitly labeling each as a fixture, not a canonical contract. The `rawEvent` on each forwarded payload preserves these markers so a duplicate or replayed event can be distinguished from a real delivery. The authoritative list of what a tenant emits comes from sending a Send-Example event from `Settings → Webhooks` — not from a public catalog.

### Vanta delivers the event type NOWHERE in the payload

The single most important thing to know about Vanta's webhook delivery: **the event type is not in the body and not in any HTTP header reaching the consumer**. The full event-type string (e.g. `v1.questionnaire.created`) is visible in Svix's dashboard / Vanta's Message Logs because Svix tracks message types internally — but **that metadata is not forwarded**. The actual body delivered for a `v1.questionnaire.created` event is literally:

```json
{"questionnaire": {"id": "123"}}
```

Only the three standard `svix-id` / `svix-timestamp` / `svix-signature` headers ship. No `webhook-event-type`, no `x-vanta-event-type`, no envelope `type` field.

**Implication for consumers:** with one endpoint subscribed to multiple event types, the **entity** can be inferred from the top-level body key (`questionnaire` / `accessRequest` / `vendorDecision`) but the **lifecycle stage** (`created` vs `deleted` vs `export-failed`) is unrecoverable from the webhook alone.

**LlamaLync's workaround:** [`transformEventToPayload`](../../src/webhooks/webhookForward.js) extracts the entity from the body and reports the event type as a family wildcard (`v1.questionnaire.*` etc.) for real Vanta deliveries — the payload's `summary` field uses honest family-level phrasing ("Questionnaire event received from Vanta") rather than guessing a lifecycle stage. Demo replays carry a synthetic `_demoEventType` field that is read first, so demo payloads show the full event type with the per-type summary and workflow hints.

A fix on Vanta's side would be a small change — add `type` to the body envelope OR set a custom HTTP header. The current setup-UI suggestion ("leave the selection blank to receive all events") implies multi-type-per-endpoint routing that the payload does not actually support.

---

## 4. Receive + forward pipeline

The pipeline lives in [`src/webhooks/`](../../src/webhooks/):

```
                ┌────────────────────────────────────────────┐
                │ POST /webhooks/vanta                       │
Vanta (Svix) ───┤ rawParser (1 MB cap)                       │
                │ handleWebhookRequest                       │
                │   ↓                                        │
                │ secret-configured? ─ no → 503              │
                │   ↓ yes                                    │
                │ svix.Webhook.verify(rawBody, headers)      │
                │   ↓ ok        ↘ fail → record + 401       │
                │ svix-id seen? ─ yes → record + 200 deduped │
                │   ↓ no                                     │
                │ markSeen(svix-id)                          │
                │ forwardEvent(parsedEvent)                  │
                │   ↓                                        │
                │ transformEventToPayload                    │
                │   - summary from EVENT_HINTS / family      │
                │   - workflowHints (array) from EVENT_HINTS │
                │   - vantaObject.id fallback chain          │
                │   - rawEvent preserved verbatim            │
                │   ↓                                        │
                │ mockWorkflowSink.receivePayload(payload)   │
                │   ↓                                        │
                │ eventStore.recordEvent({                   │
                │   svixId, eventType, verification,         │
                │   dedupe, forward, processingStatus        │
                │ })                                         │
                │   ↓                                        │
                │ 200 { received: true, forwarded: true }    │
                └────────────────────────────────────────────┘
```

**Two in-memory stores, both reset on restart:**

- **Event ring buffer** ([`eventStore.js`](../../src/webhooks/eventStore.js)) — newest 50 deliveries, full audit trail (verification + dedupe + forward state).
- **Workflow Sink destination** ([`mockWorkflowSink/index.js`](../../src/mockWorkflowSink/index.js)) — newest 50 forwarded payloads.

Forward failures **do not fail the webhook** — Vanta retrying wouldn't help if the destination is down, and `svix-id` is already marked seen. The failure is recorded on the event entry (`processingStatus: 'forward-failed'`) for operator triage.

---

## 5. UI tab structure

**Events tab** (between Risk and Compliance in the dashboard nav).

Two cards side-by-side (mirroring the source/destination layout of the other scenario tabs):

1. **Webhook events** — Vanta → LlamaLync inbound ring buffer. Columns: Received, Event type, svix-id, Signature (verified/rejected), Dedupe (fresh/duplicate), Forward (forwarded/failed/—), Status. Hero-stat above the table: total, verified, deduped, rejected, forwarded.
2. **Workflow Sink — Downstream payloads** — destination card. Columns: Received, Payload ID, Family (vantaObject.type — neutral muted badge, no severity), Summary, Vanta event, Vanta object.

**Empty state when `VANTA_WEBHOOK_SECRET` is unset:** the events card renders a "secret unconfigured" panel instead of the table, and the demo-replay buttons are not rendered. Setting the env var and redeploying brings the regular view back.

**Demo controls** in the card header (only when secret is configured):

- **Trigger demo event** — synthesizes a fresh signed event from the SAMPLES catalog, routes through the real receiver pipeline. Each click produces a new payload downstream.
- **Replay last (dedupe test)** — re-sends the previous demo event with the *same* `svix-id`. Demonstrates at-least-once dedupe: receiver acks `200 + deduped:true`, no duplicate Workflow Sink payload.

---

## 6. Key points

- Webhooks invert the integration direction. The other scenarios are
  LlamaLync calling Vanta. This one is Vanta calling LlamaLync, in real
  time, when state in the tenant changes.

- The events confirmed for this scenario are **compliance workflow
  events**, not operational alerts. There is no page when a SOC 2 test
  fails — that path is polling Vanta's read APIs. What real-time
  delivery covers: a new security questionnaire arrived, a prospect
  requested access to the trust center, a vendor decision was recorded.
  The destination is whatever workflow system the team already uses —
  Jira, Linear, Slack, Salesforce, Coupa, a homegrown GRC queue — not
  PagerDuty. LlamaLync emits a neutral payload and lets the destination
  map it to its own priority and routing rules.

- The most concrete user-facing win is the trust-center access request.
  Today, when a prospect hits "Request our SOC 2 report," that goes to
  an email alias and waits. With webhooks, that request lands in the
  sales workflow the moment it happens — prospect company, email,
  requested documents pre-populated. Approval cycle drops from hours to
  minutes.

- Vanta uses Svix for webhook delivery — signature is HMAC-SHA256 over
  the svix-id, the timestamp, and the body. Use the official Svix
  client library — it handles multi-signature key rotation and enforces
  a timestamp replay window. Hand-rolling is easy to get subtly wrong.

- At-least-once delivery is the contract — the same event may arrive
  twice. Dedupe by svix-id in the consumer. Skipping that creates
  duplicate payloads downstream, which means duplicate manual approvals
  — the GRC or sales team starts ignoring the queue within a week.

- Polling caveat is doubly important: webhooks **supplement** scheduled
  reconciliation, they do not replace it. Vanta retries failed
  deliveries for approximately five days, then drops them — if the
  endpoint is down past that window, those events are gone, and only
  the next reconciliation catches up. And because Vanta's webhook
  catalog does not appear to include operational compliance events,
  polling `/v1/tests` or `/v1/controls` remains the **only** path to
  "alert when something fails." Real-time delivery does not eliminate
  the need to poll.

---

## 7. Gotchas / limitations

- **Polling caveat — webhooks supplement, don't replace.** Vanta (via Svix) retries failed deliveries with exponential backoff for **approximately 5 days**, then drops them. If the endpoint is down past that window, those events are lost forever. Keep scheduled syncs (`/v1/tests`, `/v1/people`, etc.) running on a daily-or-better cadence so the next reconciliation catches missed state changes. Doubly important because Vanta's webhook catalog does not appear to include operational compliance events at all — for *"alert me when something fails,"* polling is the **only** path.

- **Event catalog is tenant-discovered.** The demo SAMPLES list is *not* a Vanta contract. Use Settings → Webhooks → Send Example for the authoritative list against a specific tenant.

- **Demo replay samples carry `_demo: true`.** When inspecting Workflow Sink payloads, the `rawEvent._demo` flag distinguishes a replay-synthesized event from a real Vanta delivery.

- **In-memory buffers reset on restart.** Both the event ring buffer (50 entries) and Workflow Sink (50 payloads) are in-memory only. Production deployments need persistence.

- **`VANTA_WEBHOOK_SECRET` is required.** Without it, the receiver returns 503 and the dashboard tab renders an explicit "secret unconfigured" panel. The demo-replay buttons do not render. Setting the env var and redeploying brings the scenario online.

- **Forward failures DON'T fail the webhook.** A Workflow Sink failure (or in production, a real-destination 500) is recorded on the event entry as `processingStatus: 'forward-failed'`. The receiver still acks `200` to Vanta because retrying would not help if the destination is down. Operator triage is via the dashboard's Forward column.

- **No outbound retry queue.** Forward is synchronous and in-process. At-least-once *to the destination* would require a queue + retry worker — overkill for a single-tenant scenario.

- **The legacy `x-vanta-signature` receiver is gone.** Earlier versions had a hand-rolled HMAC over the raw body. That was a pre-Svix-migration design and is no longer correct.

---

## 8. Walkthrough — what each control does

**Before triggering events:** confirm `VANTA_WEBHOOK_SECRET` is set. The Events tab should show its normal empty-state table, not the "secret unconfigured" panel.

1. **Open the Events tab.** This is the inverted scenario. The other tabs show LlamaLync pushing data into Vanta. This tab shows Vanta pushing events to LlamaLync in real time. The events Vanta emits here are workflow events — questionnaires, trust-center access requests, vendor decisions — not operational alerts like test failures. The destination on the right, Workflow Sink, is a stand-in for whatever workflow system the team already uses — Jira, Linear, Slack, Salesforce, Coupa, an internal GRC queue — not PagerDuty.

2. **Click "Trigger demo event" (first click — `v1.questionnaire.created`).** A row appears with `verified` / `fresh` / `forwarded` badges; a `payload-0001` lands with the `questionnaire` family badge and "Questionnaire created · qst-demo-001" in the summary. A new security questionnaire arrived. The payload carries the questionnaire id, a neutral summary, and a few workflow hints — review in Vanta, route to the GRC owner, assign a reviewer. In a real integration, this is the moment the GRC team's Jira card gets created. LlamaLync does not pick the priority — the destination system does, based on its own rules.

3. **Click again (`v1.questionnaire.export-failed`).** New row, same `questionnaire` family but a different summary. Questionnaire export pipeline broke. The summary surfaces the failure; the workflow hints say re-run from Vanta or escalate to Vanta support. The downstream system reads those hints and decides whether this is a P1 in Jira, an @here in Slack, or a routine task — that mapping is not LlamaLync's call.

4. **Click again (`v1.trust-center.access-request.received`).** New row with the `accessRequest` family badge. A prospect on the marketing site just hit "Request access to our SOC 2 report" on the trust center. Today, that goes to an email alias and waits. With webhooks: a payload in the sales workflow with the company and email, approve-or-deny SLA timer starts immediately.

5. **Click again (`v1.vendor.decision.created`).** New row with the `vendorDecision` family badge. Vendor decision recorded. Security just signed off on a vendor in Vanta. The procurement workflow on the right side gets the structured decision automatically — no manual sync between security's tool and procurement's tool.

6. **Click "Replay last (dedupe test)."** Left card shows a new row with `duplicate` and `deduped` badges; right card does NOT gain a new payload. Vanta uses at-least-once delivery — the same event can arrive twice. This button reuses the previous svix-id to exercise the dedupe path. The receiver acks 200 so Vanta stops retrying, but skips the forward — no duplicate payload on the destination side. Without dedupe, GRC or sales would get duplicate work items and start ignoring the queue.

7. **(Optional) empty-state hint:** demo samples are exactly that — samples. The real Vanta event catalog is tenant-discovered via Settings → Webhooks → Send Example in the Vanta UI.

**Common misconceptions to avoid:**

- "Webhook me when a SOC 2 test fails." The events confirmed for this scenario are workflow events, not operational alerts. For *"alert when a test fails / control is overdue,"* poll `/v1/tests` / `/v1/controls` instead. Always check the tenant's `Settings → Webhooks` catalog before assuming any operational event is emitted.
- "Webhooks mean you never need to poll Vanta again." See §7. Webhooks supplement reconciliation; they do not replace it. Retry exhaustion is ~5 days, and operational state changes are not emitted via webhook anyway.
- "Here are all the events Vanta supports." The catalog is tenant-discovered, not doc-guaranteed. The list captured in this doc (questionnaire / trust-center / vendor decision) is what one tenant's UI showed — other tenants may have more or fewer.
- "In-memory event store is fine for production." It is fine for a single-tenant scenario. Production wants persistence + an outbound retry queue.
- "Forward failures fail the webhook." They do not. Vanta gets a 200; operators triage failed forwards via the dashboard.
- "LlamaLync decides the priority of the downstream item." No — the payload is intentionally neutral (no severity). Priority is the destination system's call.

---

## 9. Future work

- **Persistence** — replace in-memory ring buffer + svix-id set with a small SQLite or LevelDB store so restarts do not lose events.
- **Outbound retry queue** — for the real-destination case, an in-process queue with exponential backoff + dead-letter logging.
- **Per-tenant routing** — multi-tenant deployments would route incoming events to a tenant-specific destination based on the tenant id in the event payload.
- **Webhook replay from real history** — Svix supports replaying historical deliveries by id range. A "replay range" mode would help when wiring up a new destination after a tenant has been emitting for a while.
- **Trigger custom event** — current replay rotates through fixed SAMPLES. A "trigger from JSON" form could accept a real "Send Example" payload from a tenant and route it through.

---

## Sources

- Vanta webhook docs: <https://developer.vanta.com/docs/webhooks>
- Svix Node SDK: <https://github.com/svix/svix-webhooks/tree/main/javascript>
- Svix signature scheme reference: <https://docs.svix.com/receiving/verifying-payloads/how-manual>
- LlamaLync receiver: [`src/webhooks/webhookReceiver.js`](../../src/webhooks/webhookReceiver.js)
- Event store + dedupe: [`src/webhooks/eventStore.js`](../../src/webhooks/eventStore.js)
- Forward pipeline + event-to-payload transform: [`src/webhooks/webhookForward.js`](../../src/webhooks/webhookForward.js)
- Demo replay: [`src/webhooks/webhookReplay.js`](../../src/webhooks/webhookReplay.js)
- Workflow Sink destination: [`src/mockWorkflowSink/index.js`](../../src/mockWorkflowSink/index.js)
- Sibling scenario docs: [personnel.md](personnel.md), [devices.md](devices.md), [risk.md](risk.md), [evidence.md](evidence.md)
