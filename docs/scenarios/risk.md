# Risk Scenario — design spec

**Customer-facing system name:** Risk-X (homegrown internal risk register, mirrors the People-X naming convention).

---

## 0. The architectural twist

**Risk is a Manage Vanta write, not a Build Integrations push.** This is fundamentally different from the Personnel scenario.

| | Personnel | Risk |
|---|---|---|
| Vanta API surface | Build Integrations | **Manage Vanta** |
| Credential | `buildAuth` (`connectors.self:*`) | `manageAuth` (`vanta-api.all:*`) |
| Scope | `:read` + `:write` granted | `:read` + `:write` granted |
| Endpoint shape | `PUT /v1/resources/user_account` | `POST /v1/risk-scenarios` (create) and `PATCH /v1/risk-scenarios/{riskScenarioId}` (update) |
| Rate limit | 20 req/min | 50 req/min |
| Identifier | source-system `externalId` | Vanta's `riskScenarioId` *or* source-system optional `riskId` |
| Snapshot semantics | Full-snapshot PUT; missing rows soft-deleted | Per-record create or update; **no PUT-empty-deletes-all** |
| Idempotency model | Server-side via `externalId` | Client-side: list-and-diff, then route to POST or PATCH |

### Why this matters

Not every "push into Vanta" is a Build Integrations push. The Risk module accepts direct writes via the Manage Vanta surface — different credential, different scope, different rate limit, different idempotency model. The choice of surface depends on whether you are feeding a native Vanta module (Risk, Vendors) or extending Vanta with a non-native data type (custom user accounts on a bespoke HRIS).

---

## 1. Customer archetype + pain

**Archetype:** mid-to-large enterprise that adopted Vanta for SOC 2 / ISO after years of running their own risk program in a homegrown internal tool.

**Source system:** Risk-X — internal-only web app, predates Vanta adoption by 5+ years. Won't be migrated off because:

- Wired into incident retro workflow
- Has historical scoring trends nobody wants to lose
- Legal uses it for litigation-hold flags
- Migration cost vs. just-mirror-into-Vanta cost is lopsided

**Pain points:**

- **Audit prep re-keying** — 200+ risks manually re-entered into Vanta for SOC 2. ~40 hours of analyst time. Error-prone.
- **Two sources of truth** — when the security committee updates Risk-X, Vanta goes stale. Auditor asks: *"how do you know your risks in Vanta are current?"* The answer cannot be "we hope so."
- **Owner/treatment mismatch** — risk owners change; treatments evolve from Mitigate → Accept as compensating controls land. Without sync, Vanta lags reality.
- **No native ingestion path** — Vanta has CSV upload and native integrations for some commercial GRC platforms, but bespoke registers need custom middleware.

---

## 2. Mock source system

**Module:** `mockRiskRegister/` (mirrors `mockHris/`)

**Mock data:** `mock-data/risks.json` — ~15-20 risks, designed to span:

- ~3 risks per category across: Access Control, Cryptography, Privacy, Vendor/Third Party, Operations, Business Continuity
- Inherent vs. residual scoring with realistic deltas (some big gaps → effective mitigations; some small gaps → ineffective)
- All four treatments represented (Mitigate, Transfer, Avoid, Accept)
- ~3 risks marked `status: "Closed"` to exercise that path
- One risk overdue for review (`lastReviewedAt` > 365 days) → drives the "stale risk" UI cue

**Example row:**

```json
{
  "internalId": "RX-2024-007",
  "title": "Insufficient secrets rotation on production databases",
  "description": "Production DB credentials are rotated annually rather than quarterly per policy SEC-014. Service accounts retain access even when an engineer offboards.",
  "category": "Access Control",
  "ciaImpact": ["Confidentiality", "Integrity"],
  "inherent": { "likelihood": 4, "impact": 5 },
  "currentMitigations": "Vault-based secret storage; quarterly access review; HSM for the most sensitive 3 DBs.",
  "residual": { "likelihood": 2, "impact": 4 },
  "treatment": "Mitigate",
  "ownerEmail": "sec-lead@example.com",
  "status": "Open",
  "lastReviewedAt": "2026-02-10",
  "linkedControlIds": ["SOC2-CC6.1", "ISO-A.9.4.3"]
}
```

`lastReviewedAt` is a **source-side-only** field — the Vanta write API does not currently expose a review-date field. It is used to drive stale-risk UI cues in the dashboard but is not written to Vanta.

---

## 3. Vanta API surface (corrected against public docs)

**Endpoints (per [Vanta developer docs](https://developer.vanta.com/reference/createriskscenario)):**

| Operation | Endpoint | Notes |
|---|---|---|
| List | `GET /v1/risk-scenarios` | Cursor pagination; filter by category / review status |
| Get | `GET /v1/risk-scenarios/{riskScenarioId}` | Accepts custom Risk ID or Mongo ID |
| Create | `POST /v1/risk-scenarios` | `description` required |
| Update | `PATCH /v1/risk-scenarios/{riskScenarioId}` | Partial update |

**No public DELETE on this surface.** Risk closure handled source-side (see §6).

### Field mapping

| Risk-X field | Vanta field | Notes |
|---|---|---|
| `internalId` | `riskId` (on create) | Preserves source identity for client-side dedupe |
| `title` + `description` | `description` | Concat with `\n\n` separator |
| `category` | `categories` (array) | Free-form; new names create custom categories — keep our list closed (§6) |
| `ciaImpact` | `ciaCategories` | Enum-locked: Confidentiality / Integrity / Availability |
| `inherent.likelihood/impact` | `likelihood` / `impact` | 1-5 default scale; tenant-configurable |
| `residual.likelihood/impact` | `residualLikelihood` / `residualImpact` | Same scale |
| `currentMitigations` | `note` | Free-text |
| `ownerEmail` | `owner` | **Must be email of a Vanta user (license-holder)**, not just a Person record |
| `treatment` | `treatment` | Enum: Mitigate / Transfer / Avoid / Accept — direct match |
| `linkedControlIds` | `customFields[ { label: "Source Control IDs", value: [...] } ]` | Locked label set (§6) |
| `internalId` (again, on every sync) | `customFields[ { label: "Source Risk-X ID", value: "..." } ]` | Audit traceability |
| `status` (source-side) | `customFields[ { label: "Source Status", value: "..." } ]` | Workaround for absent native status (§6) |

**Hardcoded:**

- `riskRegister` — **REQUIRED** even in single-register tenants (verified empirically — public docs lag). Sourced from `VANTA_RISK_REGISTER` env var; the sync job fails fast at startup if unset. Set to the register's name as shown in the Vanta UI (typically `Default`).
- `type` — `"Risk Scenario"` (default; Enterprise Risk is a different concept with no register).

---

## 4. Sync algorithm

```text
1. Read Risk-X mock register → array of source rows
2. List Vanta risk scenarios via GET /v1/risk-scenarios (paginated)
3. Build a map: vantaByRiskId = { riskId → riskScenarioId }
4. For each source row:
     - If source.internalId in vantaByRiskId:
         → PATCH /v1/risk-scenarios/{riskScenarioId}
     - Else:
         → POST /v1/risk-scenarios   (include riskId = source.internalId)
5. Stale records (in Vanta but not in source):
     → leave in place (no DELETE available; no PUT-empty semantics)
     → optionally update customFields["Source Status"] = "Removed-from-source"
```

**Why not blindly POST and let the server reject duplicates:** the public API separates create and update. POST on an existing `riskId` may 409 or silently create a duplicate — neither is acceptable.

**Persistence is not required for idempotency.** The list-and-diff happens every sync — no need to persist an `internalId → Mongo ID` map. (Persistence would be nice for UI deep-links into Vanta from the dashboard, but treat it as a UX enhancement, not a correctness requirement.)

---

## 5. UI tab structure

A new `Risk` tab in the dashboard, same visual language as Personnel:

```text
┌─ Header: Risk-X → Vanta Risk Module ─────────────────────────┐
│  Manage Vanta credential. Source-of-truth: Risk-X.            │
│                                                                │
│  [ Sync All ]  [ Add Risk ]  [ Apply Treatment ]              │
│  [ Mark Closed in Risk-X ]                                    │
└────────────────────────────────────────────────────────────────┘

┌─ Source: Risk-X register ──┐  ┌─ In Vanta: Risk Scenarios ──┐
│  RX-2024-001  Phishing      │  │  ☑ RX-2024-001  Synced     │
│  RX-2024-007  Secrets rot.  │  │  ⚠ RX-2024-007  Stale       │
│  RX-2024-014  Vendor DDoS   │  │  ☐ RX-2024-014  Missing     │
└─────────────────────────────┘  └─────────────────────────────┘

┌─ 5×5 Risk Matrix (inherent → residual heatmap) ──────────────┐
│  [visual showing each risk's position + arrow to residual]    │
└────────────────────────────────────────────────────────────────┘

┌─ Activity log ────────────────────────────────────────────────┐
│  10:14:22  PATCH /v1/risk-scenarios/RX-2024-007 → 200         │
│  10:14:21  POST  /v1/risk-scenarios               → 201       │
│  10:14:20  GET   /v1/risk-scenarios?pageSize=100 → 200 (12)  │
└────────────────────────────────────────────────────────────────┘
```

### Action behaviors

| Button | What it does |
|---|---|
| **Sync All** | List-and-diff against Vanta. POST new, PATCH existing. Logs each call. |
| **Add Risk** | Simulates a new risk identified at this month's security committee. Appends to Risk-X mock register; on next Sync All, gets POSTed to Vanta. |
| **Apply Treatment** | Picks a risk currently showing inherent-only scoring; applies residual numbers in Risk-X; on next Sync All, PATCHes Vanta. Demos the lifecycle. |
| **Mark Closed in Risk-X** | Flips source-side `status` to `Closed`. **Does NOT claim Vanta-native closure** — syncs as `customFields["Source Status"] = "Closed"` and updates the dashboard's "Closed" filter. |

The 5×5 risk matrix is the visual punch — same effort as the Personnel roster, dramatically more legible at a glance.

---

## 6. Locked customFields contract

`customFields` labels become tenant-side custom fields permanently the first time they are written. To prevent run-to-run drift polluting the tenant with churning labels, the integration locks the following labels in a constant:

```js
// src/sync/jobs/riskSync.js
const RISK_CUSTOM_FIELDS = Object.freeze({
  SOURCE_ID: 'Source Risk-X ID',
  SOURCE_STATUS: 'Source Status',
  SOURCE_CONTROL_IDS: 'Source Control IDs',
  SOURCE_LAST_REVIEWED: 'Source Last Reviewed'
});
```

Any change to these labels is a deliberate breaking change requiring tenant cleanup. Never compute label strings from data.

---

## 7. Key points

1. **The architectural distinction.** Two ingestion patterns — Build
   Integrations for *extending* Vanta with custom resource types,
   Manage Vanta for *writing to* Vanta's native modules. Risk is the
   latter. Vendors will be too. This is why a real integration runs at
   least two apps, not one.

2. **No native ingestion for homegrown registers.** Vanta integrates with
   several commercial GRC tools, but a homegrown risk register requires
   custom middleware. The pattern is also how Vanta's own GRC
   integrations work under the hood.

3. **Auditor traceability.** Security committee meeting → Risk-X register
   update → nightly LlamaLync sync → Vanta risk scenario. Three links,
   fully audit-traceable. Compare to the alternative: 200 risks manually
   entered by an analyst with no traceability to source.

4. **The two-source-of-truth resolution.** Vanta is deliberately not the
   source. Risk-X stays authoritative; Vanta is downstream. A risk
   edited in Vanta directly *will* be overwritten by the next sync.
   Either Risk-X is authoritative or it is not.

5. **The control-mapping limitation.** Risk-to-control linkage in the
   register does not carry into Vanta as a true link via this endpoint —
   internal control IDs are stashed in customFields for audit
   traceability. Active mapping inside Vanta is a manual step in the UI
   or a different endpoint.

---

## 8. Gotchas / limitations

1. **`manageAuth` scope must include `vanta-api.all:write`.** The
   integration sets `manageAuth` scope to `vanta-api.all:read
   vanta-api.all:write` for risk-scenario writes ([src/auth/authManager.js:110](../../src/auth/authManager.js#L110)).

2. **Dashboard preset path uses `/v1/risk-scenarios`, not `/v1/risks`.**
   [src/dashboard/index.js:2651](../../src/dashboard/index.js#L2651) maps `manage-risks` to `/v1/risk-scenarios?pageSize=10`. The
   dropdown label "List risks" is deliberately kept — informal "risks"
   naming is fine in UI even though the API path is `risk-scenarios`.

3. **`riskRegister` field is required, full stop (verified empirically).**
   Vanta returns 422 `"Invalid fields (riskRegister)"` on POST and PATCH
   without it, even in single-register tenants. Public docs phrase this
   as "required when multi-register" — that lags behind actual API
   behavior. `runRiskSync` and `transformRisk` both fail-fast if
   `VANTA_RISK_REGISTER` is unset. Set to the register's name as shown
   in the Vanta UI (typically `Default`).

4. **No bulk endpoint.** Each create or update is one API call. 200-risk
   sync hits the 50/min Manage Vanta limit in ~4 minutes — fine for a
   sandbox. The existing Bottleneck limiter at [src/http/vantaClient.js:203](../../src/http/vantaClient.js#L203)
   already caps Manage at 50/min. Verify Risk traffic is routed through
   `manageClient`.

5. **Owner must be a Vanta user (license-holder), not just a Person.**
   Risk-X owners whose email is not a Vanta user will fail semantically —
   not silently. Preflight: list current Vanta users via Manage API,
   drop or null the `owner` field with a warning if unknown.

6. **No `externalId` field — uses `riskId` on create, `riskScenarioId`
   for read/update lookups.** Sync logic must list-and-diff on every run
   (see §4).

7. **No DELETE endpoint on this surface.** Risk closure handled as
   source-side state + `customFields["Source Status"]` mirror. The
   "Mark Closed in Risk-X" action explicitly says so — never claim
   Vanta-native closure. (Re-evaluate if a future API exposes status.)

8. **Scoring scale is configurable in Vanta settings.** Default 1-5;
   tenants can customize. The mocks use 1-5, so they are aligned. Real
   integrations should normalize against tenant settings — note this in
   a comment in the sync job.

9. **CIA categories are an enum (Confidentiality / Integrity /
   Availability).** Risk-X data with adjacent labels ("Auditability",
   "Non-repudiation") must be mapped or skipped. Strict enum behavior
   expected.

10. **No webhook for risk updates.** Vanta does not currently fire
    "risk.updated" webhooks. Sync direction is one-way (Risk-X → Vanta).
    Bidirectional support would require a poll loop on the Vanta side
    or accepting lag.

---

## 9. Verified behavior

These were not answerable from the docs alone, so they were confirmed
against the API (`src/scripts/probeRiskApi.js`). The only question that
remains open is `customFields` UI rendering in Vanta itself — a manual
Risk Management UI check.

- **Does POST with a duplicate `riskId` 409, silently create, or return
  the existing?** Confirmed: 422 (see §10 Q1).
- **What is the exact error shape for an unknown `owner` email?**
  Confirmed: 422 "Resource not found" (see §10 Q4).
- **Does `riskScenarioId` in PATCH accept the custom `riskId` form (not
  only Mongo ID)?** Confirmed: yes, custom riskId IS the canonical
  addressable ID (see §10 Q3).
- **Does PATCH null a field when omitted, or only when explicitly set to
  null?** Confirmed: preserved when omitted; must send explicit null to
  clear (see §10 Q2).
- **How does `customFields` render in the Vanta Risk UI?** Open; verify
  manually in Vanta Risk Management after a sync.

---

## 10. Probe findings (verified against the API)

`src/scripts/probeRiskApi.js` runs five surgical calls against the sandbox
tenant. One or two probe risks may be created per run: the general probe risk
for probes 1–4, plus the unknown-owner probe only if Vanta unexpectedly accepts
that owner. No DELETE endpoint exists — cleanup is manual via the Vanta UI.

### Q1 — Duplicate `riskId` POST → 422 "Invalid fields (riskId)"

Vanta enforces uniqueness on `riskId`. The error idiom `"Invalid fields (X)"`
names the offending field. **List-and-diff is required**, not just defensive.

### Q2 — PATCH preserves omitted fields (load-bearing for `transformRisk`)

```
4a (before): residual = { likelihood: 1, impact: 2 }
4b: PATCH with note only — residual fields OMITTED from body
4c (after):  residual = { likelihood: 1, impact: 2 }   ← unchanged
```

**Consequence on `transformRisk`:** untreated risks on the PATCH path must
send explicit `residualLikelihood: null`, `residualImpact: null`, and
`note: null` rather than omitting. POST untreated can still omit (nothing
to clear yet). See `transformRisk` body comment and test `PATCH sends
EXPLICIT null for residualLikelihood / residualImpact / note`.

### Q3 — Custom `riskId` IS the canonical addressable ID

Probe 3 PATCHed `/v1/risk-scenarios/{custom-riskId}` directly — 200 with
the updated risk. **No separate Mongo ID is returned by Vanta.** The
`diffAgainstVanta` helper's fallback chain (`riskScenarioId || id ||
customId`) is over-engineered for this surface; in practice `customId`
is what production hits. Kept defensively in case Vanta's response shape
changes later.

### Q4 — Unknown owner → 422 "Resource not found"

Vanta validates `owner` via lookup against the people pool. Confirms the
preflight-then-omit/null pattern is the right defense; if preflight ever
falls back (e.g. `/v1/people` is down), an unknown owner reaching Vanta
will surface a 422 the sync loop already catches and records in
`stats.errorDetails`.

### Bonus findings (response-shape observations)

- **Category normalization.** Vanta normalized `"Access Control"` →
  `"Access control"` (lowercase 'c') in the stored value. Does not break
  the push but worth knowing for any UI round-tripping.
- **`reviewStatus: "DRAFT"` is the default** for risks created via API.
  Risks sit in DRAFT until approved through the Vanta UI workflow. The
  dashboard Risk tab surfaces this as per-row review-status badges.
- **Auto-populated fields** in the response that do not need to be sent:
  `identificationDate`, `isSensitive`, `isArchived`, `requiredApprovers`.

### Probe artifacts to clean up

Each probe run leaves one or two risks in the tenant with names prefixed
`LLAMALYNC-PROBE-{YYYYMMDD-HHMM}-NNN`. Descriptions say "safe to delete."
Delete via Vanta UI → Risk Management when convenient.

---

## Sources

- [Vanta — Create a risk scenario](https://developer.vanta.com/reference/createriskscenario)
- [Vanta — List risk scenarios](https://developer.vanta.com/reference/listriskscenario)
- [Vanta — Get a risk scenario](https://developer.vanta.com/reference/getriskscenario)
- [Vanta — Update a risk scenario](https://developer.vanta.com/reference/updateriskscenario)
- [Vanta API overview (rate limits, errors)](https://developer.vanta.com/docs/vanta-api-overview)
