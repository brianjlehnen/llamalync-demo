# LlamaLync Build Log

Integration notes for the LlamaLync reference architecture. What each scenario
revealed about Vanta's Build Integrations and Manage Vanta APIs, in the order
the build encountered them. The Vanta developer docs are accurate but thin in
spots; this file fills those gaps with empirical findings against a real
tenant.

Status as of this writing: Build Integrations side (personnel push) verified
end-to-end. Manage Vanta side (read of `/v1/people`, `/v1/tests`, etc.) and
deployment are still ahead.

---

## Who this is for

Engineers building a custom integration that pushes data into Vanta — typically
from a homegrown HRIS, IT system, CMDB, or vulnerability scanner Vanta doesn't
have a native connector for. Assumes access to a Vanta tenant and the
Developer Console.

---

## Prerequisites

- A Vanta tenant with admin access (the Developer Console lives at
  `https://app.vanta.com/developer`).
- Node.js 18+.
- A separate workspace for testing is ideal but not strictly required — there
  is no documented sandbox tenant. In practice, push synthetic data and clean
  up after.

---

## One-time setup in Vanta

The Developer Console has two relevant app types:

| App type | What it can do | Scopes |
|---|---|---|
| **Build Integrations** | Push custom resources (user accounts, devices, vulns) | `connectors.self:read-resource`, `connectors.self:write-resource`, `self:write-document`, `self:read-document` |
| **Manage Vanta** | Read/write existing Vanta entities (`/v1/people`, `/v1/tests`, `/v1/controls`, `/v1/vulnerabilities`) | `vanta-api.all:read`, `vanta-api.all:write`, etc. |

**Both are needed for any non-trivial integration.** Build Integrations
pushes raw IAM data; Manage Vanta promotes it into Vanta's native entities
(People, Tests). One app cannot bridge both surfaces — common surprise.

### Step 1 — Create the Build Integrations app

1. Developer Console → Apps → "Create app" → **Build Integrations**.
2. Name it (e.g. "LlamaLync Sync").
3. Note the **Client ID**, **Client Secret**, and **Integration ID** (24-char
   hex). Put these in `.env` as `VANTA_CLIENT_ID`, `VANTA_CLIENT_SECRET`,
   `VANTA_INTEGRATION_ID`.

### Step 2 — Declare a resource

This is the step that's easy to miss. Until a resource is declared, every
push returns 404 because Vanta doesn't know what shape to validate
against. The integration's `resourceKinds` array reflects what's declared —
empty means nothing's there yet.

1. Developer Console → your app → **Resources** tab → **+ Create Resource**.
2. **Base Resource Type:** `user_account` for personnel. (`computer` for
   devices, `vulnerability` for CVE-style data, etc.)
3. **Resource Id:** an identifier referenced in the API body. The
   Developer Console assigns a 24-char hex object id; a slug works too.
   Either way, capture it as `VANTA_PERSONNEL_RESOURCE_ID` in `.env`.

After saving, the integration's `resourceKinds` should now include
`UserAccount`.

### Step 3 — Local setup

```
cp .env.example .env
# fill in the four VANTA_* values from steps 1 and 2
npm install
npm run check:auth     # smoke-test — confirms credentials + token caching
npm run sync:personnel # full snapshot push of mock-data/employees.json
```

---

## Schema discovery — the part that isn't in the docs

The `user_account` schema is strict. A payload missing a required field
returns `400` with a body like
`{"error":"/0: must have property 'fullName'"}`. An unknown field returns
`Too many fields on resource with uniqueId X. Extra keys: ...` listing every
extra. **There is no warn-level tolerance** — one bad field kills the whole
snapshot.

The docs page (`/docs/vanta-user-accounts-resource`) gives the path and a
loose body shape, but not the field names or enum values. The reliable
discovery technique is to probe the API itself:

```js
// One PUT, single record, see what it complains about, fix, repeat.
await axios.put('https://api.vanta.com/v1/resources/user_account', {
  resourceId: process.env.VANTA_PERSONNEL_RESOURCE_ID,
  resources: [{ /* candidate payload */ }]
}, { headers: { Authorization: 'Bearer ' + token } });
```

Each 400 names the next required field. After the required set is
satisfied, send a maximalist payload with every plausible field — the error
lists every extra key to remove.

The `user_account` schema converged on (current as of build):

| Field | Notes |
|---|---|
| `uniqueId` | Stable id from the source. **Do not reuse** ids — Vanta treats reuse as the same record. |
| `email` | Primary key for cross-system join (e.g. matching to People). |
| `displayName` | What shows in lists. |
| `fullName` | Required even when same as `displayName`. |
| `accountName` | Login handle. LlamaLync uses the email local-part. |
| `externalUrl` | Deep-link back to the source system's profile page. |
| `permissionLevel` | Enum. Verified: `ADMIN`, `BASE`. Rejected: `USER`, `STANDARD`, `OWNER`, `NORMAL`, `REGULAR`. |
| `mfaEnabled` | Bool. |
| `mfaMethods` | Array. Empty `[]` is accepted. |
| `status` | `ACTIVE` works; assume the others follow Vanta convention. |
| `authMethod` | `PASSWORD` works. SSO/SAML probably valid — verify before relying. |
| `createdTimestamp` | ISO 8601 string. (Note: not `createdTimestampMs`.) |
| `lastLoginTimestamp` | ISO 8601 string. |

**Fields the schema rejects** (tested empirically): `employmentStatus`, `accountType`,
`isActive`, `ssoEnabled`, `passwordAuthenticated`, `passwordLastChangedTimestamp`,
`jobTitle`, `department`, `isServiceAccount`, `groups`. Most of these are
HR-shaped — see next section.

---

## The IAM vs HR split

`user_account` answers "does this human have a login on this system, with
what auth posture?" It does **not** answer "is this person currently employed,
in what role, in which department?" That distinction is what makes the
extra-field rejections look strange at first.

For HR-shaped data (Person/employment records), the **Vanta API does not
expose a write endpoint** — `POST /v1/people` returns 404, `PUT /v1/people/{id}`
returns 404, and there is no `person`/`employee` base type in Build
Integrations. Verified empirically.

The supported channels for getting Person records into Vanta are:

1. **Native HRIS connectors** — Workday, BambooHR, Rippling, Gusto, etc.
2. **SCIM provisioning** — when a SCIM 2.0 provider is connected
3. **Manual UI entry** — direct edit in Vanta
4. **CSV bulk upload** — through the Vanta UI

Custom integrations like LlamaLync are NOT in that list, and they don't
need to be — they solve a different problem.

**The scenario LlamaLync solves:** an organization has a system where
people have *access* (e.g., the bespoke "People-X" HR application). The
CISO wants Access Reviews on that system — i.e., who has access, should
they still have it? LlamaLync pushes the access list as `user_account`
records. Vanta's Access Review module consumes those records to drive
the periodic review workflow. The Person/HR data side is a separate
ingestion path handled independently.

---

## Full-snapshot semantics

This one is documented, but the docs phrase it gently. It is not gentle:

> Every PUT request to sync resources into Vanta provides a full state of
> available resources.

In practice:

- `PUT [Alice, Bob, Carol]` followed by `PUT [Alice, Bob]` → Carol gets
  `deletedAt` set to the timestamp of the second PUT.
- `PUT []` → every record under that resourceId gets soft-deleted.
- A naive loop that does one PUT per record will, by the time it finishes,
  have an integration showing only the *last* record. Everyone else is
  soft-deleted.

Verified empirically: a probe record created during schema iteration was
present until the next PUT (the real personnelSync) ran without it; it then
appeared in the GET response with `deletedAt` populated to the snapshot
timestamp.

**Defensive practice:** before PUT, sanity-check the count. Aborting when
`resources.length === 0` and the source of truth had records yesterday is
the difference between a stale snapshot and a tenant-wide phantom-offboard.

---

## Reading what you pushed

There is no MCP tool that lists resources for a Build Integrations
integration directly. But the same OAuth token can hit the read endpoint:

```
GET /v1/resources/user_account?resourceId={VANTA_PERSONNEL_RESOURCE_ID}
```

Returns `{ resources: [{ uniqueId, displayName, externalUrl, createdAt,
updatedAt, deletedAt, ... }] }`. Notably the response **includes
soft-deleted records** with `deletedAt` set — useful for audit, surprising
on first read.

The MCP `people` tool reads the Manage Vanta People entity, not user_accounts.
It's the right tool for verifying Manage Vanta pushes, not Build Integrations
pushes.

---

## Reading from Manage Vanta — schema notes

A few things to know about the Manage Vanta read endpoints beyond what
the docs spell out (verified empirically against a real tenant):

- **`/v1/controls`** returns control *requirements*, not pass/fail outcomes.
  Fields: `id`, `externalId`, `name`, `description`, `source`, `domains`,
  `owner`, `role`, `customFields`, `creationDate`, `modificationDate`.
  No `status` field. Pass/fail evaluation lives on `/v1/tests`.
- **`/v1/tests`** has the `outcome` field — useful values include `FAIL`
  for the failing-tests query. Filter at request time.
- **`/v1/people`** returns the People entity (employment, name,
  groupIds, tasksSummary). Empty `tasksSummary.status === "NONE"` means
  no tasks assigned, not a clean record.
- **`/v1/vulnerabilities`** supports `status=OPEN` and a date filter
  `remediationDeadlineBefore=<ISO>` for the "approaching SLA" use case.

The general lesson: don't assume one resource type's schema applies to
another. Probe the actual response before wiring up rendering logic.

## Common errors and what they actually mean

| Status | Body | Meaning |
|---|---|---|
| 401 | `unauthorized` | Token expired or missing — token cache may be stale. |
| 403 | `unauthorized` on `/v1/people`, `/v1/tests`, `/v1/controls` | You're using a Build Integrations token on a Manage Vanta endpoint. Wrong app. |
| 404 | `Cannot POST /v1/...` | Path is wrong (HTML response = Express's default 404, not a Vanta-shaped error). |
| 404 | JSON-shaped on a path that should exist | Resource type not declared in Developer Console. |
| 400 | `must have property 'X'` | Schema requires field X. |
| 400 | `Too many fields ... Extra keys: ...` | Schema rejects every listed field. Remove and retry. |
| 400 | `must be equal to one of the allowed values` | Enum mismatch. The error doesn't list valid values — probe by trial. |
| 403 | **HTML body** starting with `<!DOCTYPE HTML…CloudFront`, `Bad request. We can't connect to the server` | Edge-level rejection by CloudFront's WAF, not a Vanta-API-shaped error. Most common trigger seen so far: a GET request that carries a body. axios with `axios({ method: 'GET', data: null })` will serialize `null` as the literal request body — fatal. The fix is to omit `data` entirely on GETs (see vantaClient.js — `if (data != null)` guard around `config.data`). |
| 429 | `rate limit exceeded` | 20/min on Build Integrations, 50/min on Manage Vanta. The HTTP client backs off and retries automatically. |

---

## Architecture decisions worth knowing

These are baked into the codebase already; documented here as design
rationale rather than as something to rediscover.

- **One singleton `AuthManager`.** Vanta's "one active token per app" rule
  means parallel token fetches cause silent revocation of in-flight requests.
  A singleton with a cached token avoids the race. Implication for HA:
  scaling to multiple replicas requires a shared token cache (Redis or
  similar) — pure stateless replicas will keep stealing each other's tokens.
- **Bottleneck reservoir at 20/min.** Conservative — matches the lower of
  the two rate-limit buckets. Manage Vanta requires a separate limiter for
  that client at 50/min.
- **`pageSize: 100` everywhere.** Maximum allowed. Lower would mean more
  cursor calls against the rate limit.
- **Token cache refresh buffer: 60s.** Fetches a new token 60s before
  expiry to avoid a request landing exactly at the boundary.
- **Mock data, not a real HRIS.** LlamaLync reads `mock-data/employees.json`
  for deterministic behavior. In a real integration this is where the
  HRIS API call goes; everything downstream stays the same.

---

## What's deliberately not built yet

Tracking against the project plan:

- [x] Build Integrations app + scope
- [x] OAuth + token cache
- [x] Personnel push (active employees)
- [x] Manage Vanta app + credential split (two `AuthManager` instances, two `VantaHttpClient` instances with 20/min and 50/min limiters)
- [x] Personnel offboard path — **handled by Vanta automatically.** Full-snapshot PUT semantics: when an employee drops out of the source system's payload, the next sync soft-deletes the user_account in Vanta. No API call needed.
- [x] Service account marking — **handled by Vanta UI.** "Configure resource scope" dialog on the integration lets an admin toggle individual accounts in/out of compliance scope. Not an API operation.
- [ ] Devices push
- [ ] Vulnerabilities push
- [ ] Webhook receiver wired and verified end-to-end
- [x] Dashboard UI (HTML at `/`, JSON at `/dashboard.json`, two-card layout — pushed records via `buildClient`, compliance state via `manageClient`)
- [x] Fake "People-X" HRIS (mounted at `/mock-peoplex/employees.json` and `/mock-peoplex/_meta.json` inside the Express server) — stands in for a bespoke source system; dashboard renders a Source card above the build/manage grid showing the data flow end-to-end
- [x] HTTP Basic Auth — gated by `LLAMALYNC_PASSWORD` env var; `/health` and `/webhooks/*` exempt
- [x] Render deploy spec (`render.yaml`) + README instructions — one-click deploy from a connected GitHub repo
- [ ] Actually push to GitHub and deploy to Render

## The fake HRIS and its promotion path

The scenario LlamaLync demonstrates is *"a bespoke HR/IT system feeds
Vanta via this middleware."* For the demo to land, the source side has
to be visible. The current implementation lives at
`src/mockHris/index.js` and exposes:

```
GET /mock-peoplex/employees.json   →  the raw employee list
GET /mock-peoplex/_meta.json       →  source metadata + breakdown
```

Both are mounted on the same Express app as the dashboard, so when
LlamaLync deploys, the fake HRIS deploys with it. **Promotion is implicit
— no separate bucket setup, no second host.** The architectural
substitution path is:

| Stage | Source | What changes |
|---|---|---|
| Local demo | Fake HRIS at `localhost:3000/mock-peoplex/...` | Nothing — this is the current state |
| Hosted demo | Fake HRIS at `https://llamalync.example.com/mock-peoplex/...` | Deploy step (Render/Railway/Fly free tier) |
| Real source | The real source system's API or bucket-served JSON | One-line change in `personnelSync.js` to fetch from a configurable URL; mock HRIS gets retired |

The fake HRIS endpoints can stay in production builds as a known-good
"hello world" path for verifying the deployment is healthy, or be
gated behind `NODE_ENV !== 'production'` for a leaner artifact.

The offboard and service-account branches were intentionally removed from
[`personnelSync.js`](../src/sync/jobs/personnelSync.js) rather than left as
dead code. Easier to recognize the gap that way.

---

## Risk scenario — what's different

Layered on top of the Personnel build is a second scenario for the Risk
module — Risk-X (homegrown register) mirrored into Vanta's native Risk
scenarios. Most of the patterns above (mock source under `mockRiskRegister/`,
list-and-diff sync via the Manage Vanta credential, dashboard tab with
source + Vanta tables, action buttons, soft-refresh) are the same. The
interesting differences:

- **Manage Vanta write surface**, not Build Integrations push. Different
  credential pair, different rate-limit bucket (50/min vs 20/min),
  different idempotency model (client-side list-and-diff, no PUT-empty
  semantics).
- **`riskRegister` is required** even in single-register tenants — the
  public docs lag the API. Discovered during live probing.
- **PATCH preserves omitted fields**, so an untreated risk's PATCH body
  must send explicit `null` for `residualLikelihood` / `residualImpact`
  / `note` to actually clear prior treated values.
- **Custom `riskId` IS the canonical addressable ID** — `PATCH
  /v1/risk-scenarios/{riskId}` works directly; no separate Mongo ID
  step needed.
- **No DELETE on this surface.** Closure is mirrored via a locked
  `customFields["Source Status"]` label written by every sync.

Full design, slice history, and live-probe findings are in
[`docs/scenarios/risk.md`](./scenarios/risk.md).

---

## Computer resources — what's different

Layered on top of the Risk scenario is the third scenario: CMDB-X (homegrown
asset inventory) → Vanta computer resources via the Build Integrations push
surface. Same overall shape as the Personnel push (full-snapshot PUT, source
→ Vanta direction, 20 req/min bucket), but with several material schema
findings worth recording.

### Schemas are JSON Type Definition (JTD, RFC 8927), not JSON Schema

The biggest learning from initial discovery: Vanta's resource schemas are
exposed in **JTD form**, not JSON Schema. The semantic differences matter:

- `properties` = **required** object members (NOT "all properties" like in
  JSON Schema). Every top-level key under `properties` is required.
- `optionalProperties` = optional object members.
- Strict by default — extras are rejected without needing an explicit
  `additionalProperties: false`. Sending an unknown key returns 400.
- `elements` describes the shape of array items.
- Primitives: `string`, `boolean`, `int32`, `timestamp` (RFC 3339 with offset).
- `enum: [...]` for closed enumerations.
- `nullable: true` on a property allows `null` in addition to the declared type.

This explains why the `user_account` probe in the original build-log section
above reported "must have property 'fullName'" iteratively — the validator
walks the required-property list and reports one missing per response.

### Dev Console exposes the schema directly — use it before probing

The prescriptive discovery path for any Vanta base resource type is:

> Vanta Developer Console → your Build Integrations app → **Resources** tab →
> the specific Resource → **Schema** button → copy JTD.

This was discovered partway through initial discovery — after an iterative
API probe (`src/scripts/probeComputerApi.js`) had walked through 10 of the
16 required fields one PUT at a time. The probe works but takes 1–3 minutes
per platform once 20/min rate-limit retries are factored in. The Schema view
is instant. **Reach for the Schema view first; use the probe only when the
Console schema is missing or to confirm validator behavior the schema
doesn't capture.**

### Resource type naming in the path is exact-case

Both computer resource type paths use **CamelCase**, not snake_case:

- `PUT /v1/resources/MacosUserComputer`
- `PUT /v1/resources/WindowsUserComputer`

Contrast with the older `user_account` resource at
`PUT /v1/resources/user_account` (snake_case). Both forms are valid; the
naming follows whatever the Dev Console Resources tab declares as the base
type name, character-for-character.

### Linux Go/No-Go — natively unsupported

No Linux option exists in the Resources → Create Resource base-type dropdown
as of this writing. There is no `LinuxUserComputer` or equivalent.

**Implementation decision:** Linux source rows from CMDB-X surface in the
dashboard as an **"unsupported source row"** with a tooltip explaining the
native-coverage gap. They are excluded from any PUT to Vanta. This is
intentionally a demo-able state — it shows auditors exactly which devices
fall outside Vanta's native computer-resource coverage.

The two alternatives — silently dropping Linux from the push, or mapping it
to a custom resource type — were rejected: the first hides a compliance
gap, the second invents tenant-side schema that has to be authored, written,
and maintained per integration.

### MacosUserComputer — required fields

JTD `properties` block, copied from Dev Console Schema view:

| Field | JTD type | Notes |
|---|---|---|
| `displayName` | string | Human-friendly device name |
| `uniqueId` | string | Stable id from source CMDB. Same role as `user_account.uniqueId`. **NOT `externalId`** — an easy field-name mistake to make. |
| `externalUrl` | string | Deep-link back to source CMDB |
| `collectedTimestamp` | timestamp | RFC 3339 with offset (e.g. `2026-05-13T20:34:45.355Z`) — when the device data was collected |
| `osName` | string | Free-text, no enum (e.g. `macOS`) |
| `osVersion` | string | Free-text (e.g. `14.2.1`) |
| `hardwareUuid` | string | Per-device hardware identifier |
| `serialNumber` | string | |
| `applications` | array of `{name, bundleId, lastOpenedTimestamp?}` | Empty `[]` is valid (no `minItems`). `lastOpenedTimestamp` is the only optional sub-field; nullable. |
| `browserExtensions` | array of `{extensionId, name, browser: enum}` | `browser` enum: `CHROME / FIREFOX / OPERA / SAFARI / EDGE` |
| `drives` | array of `{name, encrypted, filevaultEnabled, isBootVolume?}` | macOS-specific `filevaultEnabled` |
| `users` | array of `{username, screenlockPolicies[], screenlockSettings, lastLoginTimestamp?}` | `screenlockPolicies` and `screenlockSettings` are nested objects with `{requiresPassword, screenSleepTimeoutMs}` |
| `systemScreenlockPolicies` | array of `{requiresPassword, screenSleepTimeoutMs}` | |
| `isManaged` | boolean | MDM-managed flag |
| `autoUpdatesEnabled` | boolean | |
| `customProperties` | object (empty `properties: {}`) | Required field; `{}` is valid. Tenant-side extension hook, analogous to risk-scenarios' `customFields`. |

**Optional fields (macOS):**

| Field | JTD type | Notes |
|---|---|---|
| `owner` | string, nullable | **The answer to the owner-linkage question.** Just `owner`. NOT `ownerEmail`. NOT `externalOwnerEmployeeId`. Same naming as risk-scenarios' `owner`. Email value resolves to a Vanta People record (parallel to risk owner). |
| `passwordPolicy` | `{minimumLengthRequirement: int32}`, nullable | |
| `lastEnrolledTimestamp` | timestamp, nullable | MDM enrollment date |
| `isXProtectEnabled` | boolean, nullable | macOS-specific (XProtect = built-in macOS antivirus) |

### WindowsUserComputer — required fields

Same 15 shared fields as macOS (displayName, uniqueId, externalUrl,
collectedTimestamp, osName, osVersion, hardwareUuid, serialNumber,
browserExtensions, users, systemScreenlockPolicies, isManaged,
autoUpdatesEnabled, customProperties, plus drives with a thinner shape).
The diff vs macOS:

| Field | macOS | Windows |
|---|---|---|
| App inventory field name | `applications` | `programs` |
| App inventory required item fields | `name`, `bundleId` | `name` only — no `bundleId` |
| `drives[]` required fields | `name`, `encrypted`, **`filevaultEnabled`** | `name`, `encrypted` (no filevault — would be nonsensical on Windows) |

**Optional fields (Windows-specific):**

| Field | JTD type | Notes |
|---|---|---|
| `windowsSecurityProducts` | array of `{name, category: enum, state: enum, stateTimestamp, signaturesUpToDate}`, nullable | `category` enum: `FIREWALL / ANTIVIRUS / ANTISPYWARE`. `state` enum: `ON / OFF / UNKNOWN`. |
| `windowsSecurityCenter` | object with six independent ENUM-rated signals, nullable | `firewall`, `autoupdate`, `antivirus`, `internetSetting`, `userAccountControl`, `windowsSecurityCenterService` — each rated `GOOD / POOR / SNOOZED / NOT_MONITORED / ERROR` |

Plus the same shared optionals from macOS: `owner`, `passwordPolicy`,
`lastEnrolledTimestamp`.

**Note on richness:** `windowsSecurityCenter` is materially richer than
the macOS optional set — six independent enum scores plus per-product state
in `windowsSecurityProducts`. Worth surfacing prominently in the dashboard's
Devices tab when a Windows device is in the data.

### `customProperties` — the JTD schema says required, the runtime validator says NO

The Dev Console JTD schema lists `customProperties` under `properties`
(= required, per JTD), but the runtime validator **rejects** it with
`"Too many fields on resource with uniqueId X. Extra keys:
customProperties"`. The earlier "open curiosity" — why does the existing
`personnelSync.js` omit it and still work — is answered: **personnelSync
was always correct, because the published JTD and the validated schema
disagree for this field.**

**Implementation correction:** the `commonComputerFields` helper in
[`src/sync/jobs/deviceSync.js`](../src/sync/jobs/deviceSync.js) does NOT
send `customProperties`. The original plan called for sending `{}`
defensively per the JTD declaration; smoke testing corrected that. The
transform is now empirically aligned with the validator. The
`customProperties` row in the required-field tables above is kept for
schema-documentation completeness, but flagged as **rejected at runtime
despite the JTD declaration** — do not send it.

**Key takeaway:** Vanta's Dev Console Schema view is authoritative for the
required + optional FIELDS and their TYPES, but NOT always for which fields
the runtime validator accepts. Treat the Schema view as a starting point;
always smoke-test against a sandbox tenant before declaring an integration
done. The Schema view is ~95% accurate; the 5% gap is exactly the kind of
finding that costs a 400 on first push if smoke testing is skipped.

### Path shape and full-snapshot semantics confirmed

`PUT /v1/resources/{ResourceTypeName}` with body `{ resourceId, resources: [...] }`
— same shape as `user_account`. Cleanup `PUT { resources: [] }` succeeded
for both Computer types during discovery (`{"success": true}`), confirming
full-snapshot soft-delete semantics work identically to `user_account`.

The defensive minimum-record check (don't PUT empty if the source had
records yesterday) applies equally here.

### user_account schema cross-reference

The user_account schema is also exposed via the same Dev Console Schema
view. Required fields per JTD:

| Field | JTD type | Notes |
|---|---|---|
| `displayName` | string | |
| `uniqueId` | string | |
| `externalUrl` | string | |
| `fullName` | string | |
| `accountName` | string | |
| `email` | string | |
| `permissionLevel` | enum | `ADMIN / EDITOR / BASE` (the empirical table earlier in this file only saw `ADMIN` and `BASE` — `EDITOR` is the third value, confirmed) |
| `createdTimestamp` | timestamp | |
| `status` | enum | `ACTIVE / DEACTIVATED` |
| `mfaEnabled` | boolean | |
| `mfaMethods` | array of enum | `UNSUPPORTED / DISABLED / SMS / EMAIL / OTP / HARDWARE_TOKEN / PUSH_PROMPT` |
| `authMethod` | enum | `SSO / PASSWORD / TOKEN / BIOMETRIC` |
| `customProperties` | object (empty `{}` valid) | Same caveat as Computer resources — required-but-empty-OK |

Optional: `roleDescription`, `updatedTimestamp`, `deactivatedTimestamp`,
`lastLoginTimestamp`, `lastPasswordResetTimestamp`, `groupIds` (array of
string).

The empirical Schema discovery table earlier in this file is **superseded by
this JTD-sourced table** — keep both for the discovery narrative, but treat
the JTD version as authoritative.

### What the schema view did NOT resolve for Computer resources

A few things the schema view alone couldn't tell us — resolved via
end-to-end smoke testing (findings below):

- ~~Does Vanta strictly validate `owner` as a known Vanta People email
  (the way risk-scenarios `owner` does), or accept any string?~~ **Answered:
  LENIENT — accepts any string, stores as-sent. See below.**
- ~~The exact rejected-field error idiom for this resource family.~~
  **Answered: `"Too many fields on resource with uniqueId X. Extra keys:
  Y, Z"` — same idiom as `user_account`. See below.**
- For `applications` / `programs` / `browserExtensions` / `drives`, JTD
  says empty `[]` is valid but doesn't speak to whether Vanta enforces any
  business rule (e.g. "a device with `isManaged: true` must have at least
  one user"). Not exercised here (mock data doesn't include empty-array
  edge cases).

### End-to-end smoke-test findings

End-to-end `npm run sync:devices` against a real sandbox tenant. Two
material findings:

**1. `customProperties` is REJECTED at runtime (validator vs JTD divergence).**

Initial sync 400'd immediately:

```
PUT /v1/resources/MacosUserComputer
→ 400
{ "error": "Too many fields on resource with uniqueId DEV-MAC-001 (element 0). Extra keys: customProperties" }
```

The Dev Console JTD lists `customProperties` under required `properties`,
but the validator rejects it as an extra key — same way `user_account`'s
validator behaves. The error idiom matches: `"Too many fields on resource
with uniqueId X. Extra keys: Y, Z"`. This is the *same* error pattern
captured in the `parseExtraFields` parser at
[`src/scripts/probeComputerApi.js`](../src/scripts/probeComputerApi.js)
(pattern 1). The iterative-probe approach would have surfaced this; the
Schema view path skipped it.

Fixed by removing `customProperties` from `commonComputerFields` in
[`src/sync/jobs/deviceSync.js`](../src/sync/jobs/deviceSync.js).
[`test/deviceSync.test.js`](../test/deviceSync.test.js) was flipped from
asserting `customProperties: {}` to asserting `'customProperties' in out
=== false` so this regression cannot return silently.

**2. `owner` validates LENIENTLY on computer resources (contrast with risk-scenarios).**

Read-back via `GET /v1/resources/MacosUserComputer?resourceId=...` shows
Vanta stored every owner email exactly as sent — including synthetic
`alice.nguyen@peoplex.example.com` / `bob.simpson@peoplex.example.com` /
etc. that don't resolve to any Vanta People record:

```json
[
  { "uniqueId": "DEV-MAC-001", "owner": "alice.nguyen@peoplex.example.com", "deletedAt": null },
  { "uniqueId": "DEV-MAC-002", "owner": "bob.simpson@peoplex.example.com", "deletedAt": null },
  { "uniqueId": "DEV-MAC-003", "owner": "carol.stevens@peoplex.example.com", "deletedAt": null },
  { "uniqueId": "DEV-MAC-004", "owner": "maria.santos@peoplex.example.com", "deletedAt": null },
  { "uniqueId": "DEV-MAC-005", "owner": null, "deletedAt": null }
]
```

This **contradicts the risk-scenario `owner` behavior** — the Risk-scenario
probe (docs/scenarios/risk.md §10 Q4) confirmed Vanta returns 422
"Resource not found" for unresolved owner emails on Risk writes. The
same field NAME on a different resource type has different validation
strictness. Worth noting when describing the API to users.

**Implementation implication.** The null-defense `resolveOwnerEmail()`
in deviceSync — which returns `null` when an assignedEmployeeId doesn't
resolve in the People-X roster — is **over-cautious for computer
resources** (Vanta would have accepted the email regardless). But the
same code path also handles genuine orphans
(`assignedEmployeeId === null`), so the behavior stays. Keep the
defense; document the asymmetry.

**3. Decommissioned exclusion + Linux exclusion verified end-to-end.**

Linux `unsupportedCount: 2` reported in sync stats; neither Linux device
made it into the macOS or Windows PUT (verified by reading back both
resource types). The implementation does what it says on the box.

**4. Read-back path is clean.**

`GET /v1/resources/MacosUserComputer?resourceId={id}` returns
`{ resources: [...] }` with all stored records (including the orphan with
`owner: null`). Same shape as the user_account read-back used by
[`src/reconcile/userAccountReconcile.js`](../src/reconcile/userAccountReconcile.js).
The dashboard's "in Vanta" panel can use the same pattern.

---

## People PATCH — what's different

The second discovery probe targets the Manage Vanta `/v1/people` write
surface. The earlier note in this file (under "The IAM vs HR split") said
Vanta exposed no write endpoint for People — `POST /v1/people` returned
404, `PUT /v1/people/{id}` returned 404. The follow-up probe extends
that finding with **PATCH**, which is implemented but heavily restricted.

### PATCH /v1/people/{personId} exists

`PATCH /v1/people/{id}` is implemented. It accepts the route, parses the
body, and runs JSON validation against an explicit "Patch" schema. Every
probe returned 400, but with structured validation errors that reveal
exactly what's allowed and what isn't. The endpoint is **not** 404 —
earlier build-log notes about POST and PUT 404s are still correct, but
they didn't cover PATCH.

### Error idiom

Vanta's validation-error shape on this endpoint:

```json
{
  "message": "Validation error",
  "errors": {
    "patch.<group>": {
      "message": "\"X\" is an excess property and therefore is not allowed",
      "value": { ... }
    }
  }
}
```

The error path includes the nested group: `patch.employment.jobTitle`,
`patch.name.givenName`, `patch` (when the offending key is at the
top level). Multiple errors per response — the example above shows one
error entry, but probes with multi-error responses (e.g. name with
missing-required + excess-property) carry several keys under `errors`.

### Confirmed REJECTED as "excess property"

Every HR-shaped field tested was rejected:

- `employment.jobTitle`
- `employment.department`
- `employment.employmentStatus`
- `employment.employmentType`
- `name.givenName`, `name.familyName` — Vanta uses `name.first` / `name.last`
- All three manager-shape variants: top-level `{ managerEmail }`,
  `{ employment: { managerEmail } }`, and separate `{ manager: { email } }`

A follow-up probe added three more top-level fields from the GET shape;
all rejected:

- `{ emailAddress }`
- `{ groupIds: [...] }` (snapshot value re-sent)
- `{ leaveInfo: {} }`

### Implicitly writable: `{ name: { first, last } }` together

The probe didn't explicitly test the name PAIR, but the inferred shape is
the only thing that succeeded structurally:

- PATCH `{ name: { first: 'X' } }` → 400 `patch.name.last: 'last' is required`
- PATCH `{ name: { last: 'Y' } }` → 400 `patch.name.first: 'first' is required`

In both cases, the field that WAS sent was implicitly accepted (it was not
flagged as "excess property") — the validator failed on the missing pair
member instead. The inferred writable surface is `PATCH /v1/people/{id}`
with `{ name: { first, last } }` together, full-group replacement.

The endpoint is effectively **a manual name-correction surface** plus
whatever else hasn't been tested. The name field isn't enough to carry HR
enrichment — none of jobTitle / department / employmentStatus /
employmentType / manager are accepted here.

### The `sources` block — Vanta's field-level data provenance model

The GET response on each Person record carries a `sources` block:

```json
"sources": {
  "emailAddress": { "type": "VANTA" },
  "employment": {
    "startDate": { "type": "VANTA" },
    "endDate":   { "type": "VANTA" }
  }
}
```

This is Vanta's **field-level data provenance model**. Each field's
authoritative source is tracked: `VANTA` (Vanta-internal). Presumably
also `INTEGRATION` / `HRIS` / `SCIM` / etc. in tenants connected to a
real HRIS connector. The PATCH endpoint's "excess property" rejections
on HR fields are almost certainly enforcing field-level immutability
based on source type — fields authoritatively sourced from an integration
cannot be overwritten by API callers.

**Key takeaway:**

> Vanta's data governance is **field-level**, not endpoint-level. A custom
> integration extending the People entity must respect each field's source
> type. The PATCH endpoint's narrow writable surface is the structural
> enforcement of "HRIS is the source of truth for HR data" — not a bug or
> a gap, but a deliberate provenance model. The "PATCH People to enrich HR
> fields" approach is fundamentally at odds with Vanta's data model: the
> system is designed to keep HR data authoritative from its source (HRIS)
> and prevent downstream overrides.

### Implication — customProperties fallback

The original plan ("push user_account, then PATCH People to enrich") is
**not implementable**. The PATCH endpoint rejects every HR field of
interest.

**The implementation uses the customProperties-on-user_account workaround:**

- Extend `transformEmployee` in [src/sync/jobs/personnelSync.js](../src/sync/jobs/personnelSync.js) to populate
  `customProperties: { jobTitle, department, employmentStatus, employmentType, managerEmail }`
  from People-X source data.
- The existing single-PUT personnel sync continues to be the only push —
  no second PATCH step.
- `customProperties` is required by the user_account JTD schema (see
  Computer-resource cross-reference above); the existing implementation's
  omission was a curiosity. The new implementation sends `{}` defensively
  when source data is empty.
- Drop the "two-app two-push" mental model for personnel. That pattern
  remains architecturally correct for the Risk scenario (Manage Vanta
  write) but personnel becomes a single-push flow with custom-property
  enrichment.

The framing becomes: **user_account is the IAM identity; customProperties
is the extension hook for source-system HR data.** Cleaner than the
original plan, and consistent with the customProperties pattern surfaced
in the Computer-resource schemas. The two-surface architecture lesson
moves entirely to the Risk scenario, where it's empirically correct.

### Smaller observations

- The Person entity uses `emailAddress` (not `email` like user_account)
  and `name.first` / `name.last` (not `givenName` / `familyName`). These
  are deliberate schema differences — user_account is IAM-shaped (login
  identity) and People is HR-shaped (employment record). Don't conflate.
- A separate `userId` field exists alongside `id` on the People record
  (e.g. `id=6a04e9b38a3b56f29848ddea`, `userId=6a04e9b38a3b56f29848ddf6`).
  Likely links to a Vanta User entity for permissions/login. Not relevant
  for the LlamaLync sync; surfaced here so future probes don't waste
  iterations on it.

### Unknown personId error shape — not cleanly answered

The PATCH validator runs BEFORE the id-lookup. A bogus id with the probe
body shape hit the validation-error path before reaching the missing-target
path. To test the missing-id case properly, a structurally valid PATCH
body (e.g. `{ name: { first: 'X', last: 'Y' } }`) would be needed.

Minor implication for implementation: don't rely on PATCH `/v1/people/{id}`
to surface a 404 for missing-person detection. Use `GET /v1/people` once
per sync, build an in-process email-to-id map, and detect missing-person
cases by lookup before issuing any PATCH.

---

## Document upload — what's different

The third discovery probe targets evidence-document upload — the
`self:write-document` (Build Integrations) and `vanta-api.documents:upload`
(Manage Vanta) scopes.

### Documents in Vanta = pre-defined evidence-request slots, not arbitrary files

The most important conceptual finding. A natural assumption is "upload an
arbitrary evidence file via a generic documents endpoint." That mental
model is wrong.

**A Vanta "Document" is an evidence-request slot**, predefined in the
tenant's compliance program. Each slot has:

- A slug-style id like `external-alerts-reviewed`, `access-requests`,
  `audit-cycle-documented` — human-readable, not Mongo hex
- A title (`"A process exists to identify and prioritize security vulnerabilities"`)
- A description explaining what evidence is expected
- A category (`"Vulnerability management"`, `"Account setup"`, `"Policies"`, ...)
- An `uploadStatus` field (`"Needs document"`, presumably also `"Has document"` / similar)
- A `url` field pointing to the Vanta UI

Files attach **to** these slots. New arbitrary document slots cannot be
created from the upload API — the slot catalog is tenant-state managed
elsewhere (presumably defined by Vanta's compliance framework templates).

The implication for the LlamaLync evidence-upload UX is significant:

> **Evidence upload UX = "pick an evidence-request slot, attach a file" —
> not "upload an arbitrary document."** Implementation should list
> available slots (filtered to `uploadStatus: "Needs document"` for
> unfulfilled requests) and let the user pick which slot to upload to.
> The framing is: auditors define what evidence is needed via Documents.
> A custom integration's job is to deliver files to predefined slots.

### Listing available document slots

`GET /v1/documents?pageSize=N` via the **Manage Vanta** surface (with
`vanta-api.all:read` scope — the default `manageAuth` scope set already
covers it). Returns paginated `{id, title, description, category,
uploadStatus, url}`. The Build Integrations surface requires
`self:read-document` to list documents; the `buildAuth.scope` must include
that scope for the integration to read its own slot list.

### Upload endpoint

`POST /v1/documents/{documentId}/uploads` — with `documentId` being the
slot slug (e.g. `external-alerts-reviewed`), NOT a Mongo hex id.

A natural assumption that the path is `/v1/documents/upload` is wrong; a
"negative test" confirmed `/v1/documents/upload` is a hard 404 (Express's
default `Cannot POST /v1/documents/upload` HTML 404; the route doesn't
exist).

### Both surfaces accept the upload — implementation choice

The probe ran the same upload through both:

- **Build Integrations** with `self:write-document` token → 200
- **Manage Vanta** with `vanta-api.documents:upload` token → 200

Both surfaces accept the upload with identical request shape and identical
response shape. Implementation can use either.

**Recommended choice for LlamaLync: Build Integrations** with
`self:write-document`. Reasoning:

- Canonical pairing — Build Integrations is the "extending Vanta with
  external data" surface, which is what evidence uploads are
- Rate-limit bucket separation — keeps document uploads at 20/min
  alongside other Build pushes rather than pressuring the 50/min Manage
  bucket alongside Risk-scenario writes
- Independent audit trail — document uploads are tagged to the Build
  Integrations app, not lumped under the dashboard's Manage Vanta app

Manage Vanta's `vanta-api.documents:upload` remains a documented fallback.

### Scope-toggle UX note (Build Integrations)

How scopes are managed differs between app types:

- Build Integrations scopes are selected at **app creation** in Dev
  Console
- Manage Vanta scopes are selected at **OAuth token-request time**
  (passed in the `scope` field of the POST `/oauth/token` body)

For LlamaLync's Build Integrations app, `self:write-document` and
`self:read-document` were already enabled at creation time (probe-verified:
both tokens issued cleanly with the requested scopes). A re-created app
or a fresh tenant may need the scopes checked at creation.

**One UI navigation gotcha:** Vanta's Developer Console doesn't expose a
clearly-labeled "Scopes" section on the app detail page in the current UI.
If scopes need adjusting, the app may need recreation or further hunting
through the permissions editor. Empirical test: acquire a token with the
desired scope string and check for an OAuth error — fast and definitive.

### Multipart request shape

```
POST /v1/documents/{slot-slug}/uploads
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

<ISO date string, e.g. 2026-05-13>

--boundary--
```

- **`file`** is the only required part. The probe confirmed file-only
  uploads succeed (200, full response body).
- **`description`** is optional. When provided, it's echoed back in the
  response's `description` field; when omitted, response `description: null`.
- **`effectiveAtDate`** is optional. When provided as an ISO date-only
  string (`YYYY-MM-DD`), the response's `effectiveDate` echoes it at
  midnight UTC (e.g. `2026-05-13T00:00:00.000Z`). When omitted, Vanta
  defaults `effectiveDate` to the upload timestamp.

No other metadata fields were probed; field-name fallback probes did not
need to fire because the initial probes all succeeded.

### Response shape (worth knowing for the dashboard)

Example successful upload body:

```json
{
  "id": "6a04f050409404c928c98d4a",
  "creationDate": "2026-05-13T21:42:40.230Z",
  "updatedDate": "2026-05-13T21:42:40.230Z",
  "deletionDate": null,
  "description": "<echoed from request, or null>",
  "effectiveDate": "2026-05-13T00:00:00.000Z",
  "fileName": "llamalync-probe-20260513-1642-build-fileonly.txt",
  "title": "Manual Evidence",
  "mimeType": "text/plain",
  "url": "https://app.vanta.com/<your-tenant>/doc/Manual%20Evidence-tkmzja1elzlnvfsw7rtyrp",
  "uploadedBy": null
}
```

Field-by-field:

| Field | Notes |
|---|---|
| `id` | Mongo ObjectId — the **upload id** (specific file revision), distinct from the document slot's slug. Useful for referencing a specific uploaded revision later. |
| `creationDate`, `updatedDate`, `deletionDate` | Audit timestamps. `deletionDate` is null on creation; presumably set on soft-delete. |
| `description` | Echoes the request value or null. |
| `effectiveDate` | Either the `effectiveAtDate` request value (normalized to midnight UTC) or the upload timestamp. |
| `fileName` | The multipart `filename=` value, surfaced for UI rendering. |
| `title` | **Always `"Manual Evidence"` for API-uploaded files.** Vanta labels API uploads with this title in the UI Documents view — a recognizable bucket separating native-integration evidence from custom-integration evidence. |
| `mimeType` | The multipart `Content-Type` value. |
| `url` | User-facing Vanta URL for the uploaded file. **Useful for the dashboard's "View in Vanta" link** in the Evidence tab. Note the tenant-subdomain pattern in the URL — varies per tenant. |
| `uploadedBy` | **Always `null` for API uploads via client_credentials OAuth.** Vanta has no user identity to attribute the upload to. If/when an HRIS integration links the API caller to a Vanta User, this might be set; for the LlamaLync sync (machine-to-machine), expect null. Practical implication: API-uploaded evidence shows as "uploaded by N/A" in the UI — pair with an external audit log to attribute uploads to specific runs/operators. |

### Invalid documentId error shape

`POST /v1/documents/<bad-id>/uploads` → 404, body:

```json
{ "message": "Document with id: <bad-id> not found" }
```

Clean JSON, validation runs before multipart body parsing. Implementation
can rely on this error shape to detect bad slot ids upfront — `GET
/v1/documents` once per sync, build an in-process slug set, validate the
target slug before issuing an upload.

### One distinct upload row per call

Every successful probe response carries a different `id` — Vanta treats
each call as a separate uploaded revision attached to the slot, not as
overwrite-on-conflict. The probe deliberately used distinct filenames
per call (`-build-fileonly`, `-build-with-desc`, etc.) so the multiple
uploads show as distinct rows in the Documents UI rather than colliding
on filename. Real implementation may want to surface "latest upload"
semantics in the dashboard rather than "history of all uploads ever."

### Implementation summary

The implementation uses the slot-based model:

- **Mock evidence store** (`src/mockEvidenceStore/`) — list of mock files
  with `targetDocumentSlug` field per file mapping to a real Vanta
  evidence-request slot
- **`src/sync/jobs/evidenceUpload.js`** — `POST /v1/documents/{slug}/uploads`
  with multipart shape above, using `buildClient` with `self:write-document`
- **`src/auth/authManager.js`** — `buildAuth.scope` includes
  `self:write-document self:read-document`
- **Dashboard Evidence tab** — lists available evidence-request slots
  (filtered to `uploadStatus: "Needs document"`), lets the user pick a slot
  and upload one of the mock files. Surfaces the response's `url` as a
  "View in Vanta" link
- **[`docs/scenarios/evidence.md`](./scenarios/evidence.md)** — the
  slot-based model is the architectural lesson; the framing is about
  pre-defined evidence slots vs arbitrary documents

### Cleanup from probe runs

Files attached to the `external-alerts-reviewed` slot during probing are
small (~150 bytes), labeled "Manual Evidence", and removable via the Vanta
UI → Compliance → Documents → "A process exists to identify and prioritize
security vulnerabilities".

---

## Personnel HR enrichment — there's no API path

The finding that closes the loop on Person enrichment: **Vanta does not
expose a write path for HR-shaped data on the Person entity.** Across
three writable surfaces, every HR-shaped field rejects. The custom
integration pattern that's natural to reach for — "push HRIS fields into
Vanta" — has no API answer.

### What was tested

| Surface | Test | Result |
|---|---|---|
| `PATCH /v1/people/{id}` (Manage Vanta) | Probe `{ employment: { jobTitle, department, employmentStatus, employmentType } }` plus three manager-shape candidates | All HR fields rejected as `"X is an excess property and therefore is not allowed"` (see People PATCH section above) |
| `user_account` top-level fields (Build Integrations) | Earlier empirical work (see "Schema discovery") tried `jobTitle`, `department`, `employmentStatus`, `isServiceAccount`, `groups` | All rejected as extras |
| `user_account.customProperties` (Build Integrations) | Smoke test sent `{ customProperties: { jobTitle, department, employmentStatus, managerEmail } }` on the synthetic People-X roster | `400 "Too many fields on resource with uniqueId emp-001 (element 0). Extra keys: customProperties"` — same idiom as the Computer-resource customProperties rejection |

The `customProperties` field is declared in BOTH the Computer and
user_account JTD schemas as required. The runtime validator rejects it
on BOTH. The JTD vs runtime-validator divergence is consistent across
the resource family — not specific to Computer.

### Supported HR ingestion channels

There IS a way to get Person records into Vanta — just not via custom
integration. The supported channels (per Vanta documentation and the
probe-confirmed write-block on the API surfaces):

1. **Native HRIS connectors** — Workday, BambooHR, Rippling, Gusto, ADP,
   Justworks, and others (full list in the Vanta integrations catalog).
   These ingest the full Person record including HR fields.
2. **SCIM provisioning** — when a SCIM 2.0 provider (Okta, Entra ID, etc.)
   is connected, the Person entity flows in via the SCIM integration.
3. **CSV upload** — manual import through the Vanta UI's People section.
   Useful for one-time bulk loads or off-cycle additions.
4. **Manual UI entry** — direct creation/edit of a Person in Vanta UI.

Custom integrations are deliberately NOT in this list. The architectural
boundary is structural: HR data is treated as authoritative-from-source-
of-record, and the validator's job is to keep API callers from overwriting
HRIS-sourced ground truth. The `sources` field on each Person record
(captured in the People PATCH section above — `{ "type": "VANTA" | ... }`)
is the visible enforcement of this rule.

### Implication for the LlamaLync scenario

The Personnel scenario as it stands (push `user_account` records for
Access Reviews) is correct AS-IS. What `user_account` does NOT do:

- `user_account` is IAM-shaped: login identifier, MFA, permission level,
  active/deactivated status, account auth method. Custom integrations
  push these for Access Reviews on bespoke source systems.
- HR data — jobTitle / department / employmentStatus / managerEmail —
  has no API path. Extending Vanta with a bespoke HRIS cannot bridge
  the HR side via custom integration; one of the supported channels
  above must be used.

The full scenario doc lives in
[`docs/scenarios/personnel.md`](./scenarios/personnel.md).

### Key takeaway

> Two categories of data flow into Vanta: data that is PUSHED (IAM
> identities, devices, vulns, risk scenarios, evidence files — custom
> integrations are the answer for source systems Vanta doesn't natively
> support) and data Vanta INGESTS via native connectors (HR / Person
> entity — no custom-integration path). A custom HR push isn't possible.
> If the HRIS isn't on the native list, the answer is HRIS-connector-
> feasibility or CSV upload, not custom middleware.

---

## References

- Vanta developer hub: https://developer.vanta.com/
- API access setup (OAuth, scopes): https://developer.vanta.com/docs/api-access-setup
- User accounts resource: https://developer.vanta.com/docs/vanta-user-accounts-resource
- Risk scenarios: https://developer.vanta.com/reference/createriskscenario
- Webhooks: https://developer.vanta.com/docs/webhooks
- Risk scenario design + probe findings: [`scenarios/risk.md`](./scenarios/risk.md)
- Personnel scenario design + probe findings: [`scenarios/personnel.md`](./scenarios/personnel.md)
- Evidence scenario: [`scenarios/evidence.md`](./scenarios/evidence.md)
