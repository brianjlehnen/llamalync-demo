# Evidence / Evidence-X — design spec

**Customer-facing system name:** Evidence-X (a local evidence-file repository — SharePoint folder, S3 bucket, GRC tool export, internal audit-evidence app).

---

## 0. The architectural twist

**Vanta "Documents" are pre-defined evidence-request slots, not arbitrary uploads.** This is the single biggest surprise of the scenario.

Most engineers expect an "upload arbitrary file" endpoint (like Box, Dropbox, Drive). What Vanta actually exposes is a **fixed catalog of evidence-request slots** defined by the tenant's compliance program. Each slot is a slug like `access-requests`, `audit-cycle-documented`, `external-alerts-reviewed`, with a predefined title, description (what evidence is expected), and category. Files attach to slots; the API does not create slots from scratch.

| | Personnel | Risk | Devices | Evidence (this scenario) |
|---|---|---|---|---|
| Vanta API surface | Build Integrations | Manage Vanta | Build Integrations | **Build Integrations** |
| Direction | Source → Vanta push | Manage Vanta write | Source → Vanta push | **File upload** |
| Endpoint | `PUT /v1/resources/user_account` | `POST` / `PATCH /v1/risk-scenarios` | `PUT /v1/resources/{Macos,Windows}UserComputer` | **`POST /v1/documents/{slot-slug}/uploads`** |
| Body | JSON `{ resourceId, resources }` | JSON | JSON `{ resourceId, resources }` | **multipart/form-data** |
| Identifier | source-system `uniqueId` | source-system `riskId` | source-system `uniqueId` | **Vanta-defined slot slug** |
| Idempotency | full-snapshot PUT replaces all | list-and-diff | full-snapshot PUT per platform | **Per-call upload — each POST creates a new file revision on the slot** |
| Required scope | `connectors.self:write-resource` | `vanta-api.all:write` | `connectors.self:write-resource` | **`self:write-document`** |
| Rate limit bucket | 20 req/min (Build) | 50 req/min (Manage) | 20 req/min (Build) | 20 req/min (Build) |

### Why this matters

What to upload is not a free choice — auditors define what evidence is needed via Vanta's Documents catalog. Each compliance framework brings its own set of evidence-request slots: `access-requests`, `audit-cycle-documented`, `vulnerability process docs`, and so on. The integration's job is to deliver files to the right pre-defined slots, not to invent a new document-storage surface in Vanta. The slot catalog IS the contract with the auditor — the engineering work is fulfilling each contract item.

This reframes the work from "let me upload arbitrary stuff" to "automate the evidence-collection workflow against a known catalog."

---

## 1. Customer archetype + pain

**Archetype:** GRC / compliance team at an organization doing SOC 2 / ISO / HIPAA. Evidence collection is the slow, manual, low-leverage work in every audit cycle.

**Source systems** (where evidence lives today):
- **SharePoint / Confluence / Box** — policy documents, audit playbooks, runbooks, vendor attestations
- **Jira / ServiceNow** — ticket exports for change tickets, incident records
- **CSV exports** — access reviews, asset inventories, training completion reports
- **Internal audit-evidence apps** — homegrown trackers that aggregate evidence per control
- **GRC tools (Archer, LogicGate)** — already-organized evidence, just needs to flow to Vanta

**Pain points:**

- **Audit prep is hours of manual upload.** Every audit cycle the compliance team logs into Vanta and uploads files one at a time, per slot. 50-100 slots × a few minutes each × every cycle = real hours.
- **Evidence freshness drift.** The runbook the auditor sees is whatever was last uploaded — could be a year old. There is no native "refresh this slot's evidence" automation.
- **No traceability from source to slot.** A file lands in Vanta with no breadcrumb to where it came from. Auditors trust the upload but cannot trace it back to the system of record.
- **Out-of-band requests.** Auditors ask for evidence not yet in the catalog — the slot is created manually, then a file is uploaded, then it is mentioned in the audit response. Friction.

---

## 2. Mock source system

**Module:** `src/mockEvidenceStore/` (mirrors `mockHris/`, `mockRiskRegister/`, `mockCmdb/`).

**Mock data:** `mock-data/evidence/` directory with three files + a `_manifest.json`:

| File | Target slot | Description |
|---|---|---|
| `access-review-2026-Q1.csv` | `access-requests` | Quarterly access-review export from People-X |
| `audit-cycle-2026-plan.txt` | `audit-cycle-documented` | Calendar + pre-audit checklist |
| `vuln-mgmt-process-runbook.txt` | `external-alerts-reviewed` | Vulnerability management runbook |

**Manifest schema** (per entry):

```json
{
  "filename": "access-review-2026-Q1.csv",
  "mimeType": "text/csv",
  "description": "Quarterly access review export ...",
  "targetSlot": "access-requests",
  "addedAt": "2026-03-15T16:00:00Z"
}
```

The manifest pre-binds each file to its target slot. Real integrations would either:
- Maintain a similar manifest at the source (an explicit slot-to-file map)
- Or detect target slots dynamically based on filename / folder / metadata

**No source-side mutations.** Unlike People-X / Risk-X / CMDB-X, Evidence-X has no Add / Decommission / Reassign verbs. Files are static. The only mutation is "this was uploaded to Vanta" — tracked in-memory per session via `recordUpload()` so the dashboard can render a "✓ uploaded this session" indicator without re-reading Vanta's document list per render. Reset via `POST /mock-evidencex/reset`.

---

## 3. Vanta API surface (verified empirically)

**Endpoints:**

| Operation | Endpoint | Notes |
|---|---|---|
| List slots | `GET /v1/documents?pageSize=N` | Manage Vanta read (`vanta-api.all:read`) or Build Integrations (`self:read-document`) — both work. Returns the slot catalog. |
| Upload file | `POST /v1/documents/{slug}/uploads` | Multipart/form-data. `file` part required; `description` + `effectiveAtDate` optional. Both Build Integrations (`self:write-document`) and Manage Vanta (`vanta-api.documents:upload`) accept this endpoint. |

**Slot slug examples** (verified empirically; varies per tenant compliance config):

- `external-alerts-reviewed` — "A process exists to identify and prioritize security vulnerabilities"
- `access-requests` — "Access request ticket and history"
- `audit-cycle-documented` — "Audit Cycle identified"
- `anonymous-communication-channel` — "Anonymous whistleblower channel"
- `application-session-timeout` — "Application session timeout"
- ...and many more (tenant-specific based on the customer's frameworks)

**Important:** the **slug IS the API id**. UI URL pattern is `app.vanta.com/documents/{slug}`, and the API path uses the same slug. Good developer ergonomics — `external-alerts-reviewed` is the same string in both surfaces.

**Multipart shape:**

```
POST /v1/documents/{slug}/uploads
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="file"; filename="<name>"
Content-Type: <mime-type>

<file bytes>
--boundary
Content-Disposition: form-data; name="description"

<description text>
--boundary
Content-Disposition: form-data; name="effectiveAtDate"

<ISO date string, e.g. 2026-05-14>
--boundary--
```

Only `file` is required. `description` defaults to null in Vanta when omitted. `effectiveAtDate` defaults to upload time when omitted.

**Response shape** (verified empirically):

```json
{
  "id": "6a04f050409404c928c98d4a",   // upload record id (Mongo)
  "creationDate": "2026-05-13T21:42:40.230Z",
  "updatedDate": "2026-05-13T21:42:40.230Z",
  "deletionDate": null,
  "description": "<echoed or null>",
  "effectiveDate": "2026-05-13T00:00:00.000Z",
  "fileName": "<original filename>",
  "title": "Manual Evidence",         // always — Vanta labels API uploads this way
  "mimeType": "<echoed>",
  "url": "https://app.vanta.com/<tenant>/doc/Manual%20Evidence-<id>",
  "uploadedBy": null                   // null for client_credentials OAuth (no user identity)
}
```

The `url` is user-facing — surface it back in the dashboard as a "View in Vanta" link.

### Why Build Integrations (and not Manage Vanta)

Both surfaces accept the upload. The implementation uses **Build Integrations** (`buildClient` + `self:write-document`) because:

- Canonical pairing — Build Integrations is the "extending Vanta with customer data" surface, which is what evidence uploads are
- Rate-limit bucket separation — keeps document uploads at 20/min alongside other Build pushes rather than pressuring the 50/min Manage bucket alongside Risk-scenario writes
- Independent audit trail — uploads are tagged to the Build Integrations app, not lumped under the dashboard's Manage Vanta app

### Scope add (one-time Dev Console step)

Build Integrations scopes are **app-creation-time**. The `self:write-document` and `self:read-document` scopes must be enabled when the app is created (or via "edit permissions" later if the Dev Console UI exposes that). Both scopes are already enabled in the LlamaLync Sync app, so the implementation adds them to `buildAuth.scope` at OAuth-token-request time without any other Console change.

---

## 4. Sync algorithm

Single-file primitive — one file, one slot, one upload per call. The dashboard / CLI fans this out per row when the operator clicks Upload.

```text
1. Validate filename argument
2. Read file content via mockEvidenceStore.readEvidenceFile(filename)
   - Allow-list strict (manifest entries only — prevents path traversal)
   - Returns { content: Buffer, mimeType, manifest: {...} }
3. Resolve target slot: caller-provided slotId beats manifest.targetSlot
4. Build multipart parts: { file } + optional { description } + optional { effectiveAtDate }
5. POST /v1/documents/{slot}/uploads via buildClient.postMultipart()
6. recordUpload(filename, slotId, vantaResponse) — in-session history
7. Return { filename, targetSlot, byteLength, response }
```

The multipart body is built by a small hand-rolled helper in `src/http/vantaClient.js` (`buildMultipartBody` — Buffer concatenation, no `form-data` dependency added). Same helper shape as the probe script's multipart construction.

---

## 5. UI tab structure

An `Evidence` tab in the dashboard, mirroring the existing tabs:

```text
┌─ Header: Evidence-X → Vanta Documents ────────────────────────────────┐
│  Build Integrations · self:write-document. Multipart upload.          │
└────────────────────────────────────────────────────────────────────────┘

┌─ Source: Evidence-X files ──────┐  ┌─ In Vanta: evidence-request slots ─┐
│  access-review-2026-Q1.csv ✓    │  │  access-requests       — fulfilled │
│  audit-cycle-2026-plan.txt      │  │  audit-cycle-documented — Needs    │
│  vuln-mgmt-process-runbook.txt  │  │  external-alerts-rvd   — Needs    │
└──────────────────────────────────┘  └────────────────────────────────────┘
                                       (filtered to "Needs document" by default)

┌─ Activity log ───────────────────────────────────────────────────────┐
│  10:14:22  POST /v1/documents/access-requests/uploads  → 200         │
└──────────────────────────────────────────────────────────────────────┘
```

### Action behaviors

| Button | What it does |
|---|---|
| **Upload to Vanta** (per row) | POST multipart upload to the file's manifest-bound slot. Records in session history. Refreshes both source + Vanta cards. |
| **Reset session** | Clears in-memory upload history. Slot-fulfilled state in Vanta is unchanged (POST creates revisions; there's no UNDO on the Vanta side). |

The mock evidence files come pre-bound to slots, but the dashboard CAN expose a slot picker per row for the "I want to upload this same file to a different slot" affordance.

---

## 6. Key points

1. **Evidence-as-slots is the architecture.** Vanta's Documents API is
   not "upload arbitrary files" — it is "fulfill evidence requests
   against a predefined catalog." Each slot has expected-evidence
   semantics defined by the compliance framework. The integration's job
   is to map source-of-truth evidence to the right slots, not to invent
   new document types.

2. **Slug ergonomics.** The slot id is the same string in the URL bar of
   the Vanta UI and the API path. Grab a slot id by clicking into the
   slot in Vanta UI and copying the URL — much friendlier than the
   typical "find the Mongo id in some details panel" pattern.

3. **One Build Integrations app can do multiple things.** LlamaLync runs
   Personnel push, Devices push, and Evidence upload on the same Build
   Integrations app — all three share the same credential. Two scopes —
   `self:write-document` and `self:read-document` — enabled at app
   creation. Adding scopes to an existing app may require Dev Console
   editing or re-creating the app, depending on the current UI.

4. **Auditor-facing labeling.** API-uploaded files always show as "Manual
   Evidence" in Vanta's UI. That is Vanta's auditor-facing label for
   things uploaded via API vs Vanta-managed native-integration evidence.
   It cannot be overridden — integration-driven evidence carries this
   bucket label.

5. **No user identity attribution.** OAuth client_credentials has no user
   identity, so `uploadedBy` comes back null. For auditors needing "who
   uploaded this evidence," pair the Vanta record with an internal audit
   log keyed on the timestamp. The Vanta API does not surface a way to
   attribute an API upload to a specific operator.

---

## 7. Gotchas / limitations

1. **Each upload is a new revision, not an overwrite.** Re-uploading the same file creates a new record in Vanta with a fresh `id` and `creationDate`. The slot accumulates revisions over time. "Latest only" semantics require tracking the latest `id` and deleting predecessors via the UI (no public DELETE endpoint confirmed).

2. **Title is always "Manual Evidence."** API uploads are pinned to this label in Vanta's UI. Cannot be overridden via the API as of 2026-05-13.

3. **Slot slugs are tenant-specific.** The list of available slots varies by tenant compliance config. An integration that hardcodes slot slugs may break when a customer's compliance program adds/removes frameworks. Defensive design: list slots dynamically (`GET /v1/documents`) at startup, validate target slugs before upload.

4. **No native slot-creation API.** Customers cannot create new evidence-request slots via the API. New slots come from the customer's compliance program config (adding a framework, adding a custom control). An integration that needs an evidence slot that doesn't exist must coordinate with the customer's GRC team to add it in Vanta UI first.

5. **The Build Integrations + Manage Vanta both-work observation.** Both surfaces accept the upload — implementation chooses one. The choice is about rate-limit bucket separation and audit-trail clarity, not capability.

6. **File-size cap is not yet probed.** Initial probes used a ~150-byte placeholder. Vanta likely enforces a ceiling; common cloud limits are 25-100MB. Test against expected largest-file sizes early.

7. **Multipart construction without form-data package.** The implementation uses a hand-rolled `buildMultipartBody()` helper in `src/http/vantaClient.js` to avoid the `form-data` npm dep. Buffer-based, simple to maintain, no dependency surface. If a third multipart consumer appears (vuln file uploads, etc.) it's the obvious refactor target.

8. **Slot summary does not surface integration uploads.** After a
   successful `POST /v1/documents/{slot}/uploads` (file lands and is
   visible inside the slot's revision history), the slot's `uploadStatus`
   continues to read `Needs document` at the summary level until the
   compliance engine flips it (likely keyed on `effectiveAtDate` + the
   slot's required period, possibly auditor review). For an auditor or
   operator scanning the slot list, an API-driven upload is invisible at
   the summary level — no "received via integration on $date" affordance.
   Combined with gotcha #2 (every API upload is labeled "Manual Evidence"
   with `uploadedBy: null`), integration evidence is a second-class
   citizen in the slot UX. The gap between "file landed" and "slot
   summary reflects it" is a known papercut.

---

## 8. Verified behavior

Verified empirically:

- **Upload pipeline lands successfully against a real slot.** 200,
  response carries `id`, `url`, `title: "Manual Evidence"`,
  `uploadedBy: null`.
- **`recordUpload()` session-state machinery works end-to-end.** Re-list
  via `/mock-evidencex/files.json` after the upload — the uploaded file
  carries `lastUpload: { slotId, uploadedAt, vantaUploadId, vantaUrl,
  vantaTitle }`.
- **Multipart body construction handles the mock files (600–1200 bytes)
  cleanly.** Larger files (~1MB+) not yet exercised; the `maxBodyLength:
  50MB` config is the relevant ceiling to confirm.
- **Invalid slot id returns 404** with body `{ "message": "Document with
  id: X not found" }`. Surfaces cleanly in the sync job's error path.

---

## Sources

- Probe findings: [`src/scripts/probeDocumentUpload.js`](../../src/scripts/probeDocumentUpload.js) +
  [`docs/build-log.md`](../build-log.md) "Document upload — what's different"
- Vanta document upload reference (the public docs page describing the endpoint):
  https://developer.vanta.com/reference/uploaddocument
