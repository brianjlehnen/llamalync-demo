# Personnel / People-X — design spec

**Customer-facing system name:** People-X (homegrown HRIS / internal employee directory / bespoke HR app).

HR enrichment investigation closed — **no API path exists for HR data**, see §0 and §3.

---

## 0. The architectural twist

**There are two categories of data flowing into Vanta, and custom integrations can only do one of them:**

| | What custom integrations CAN do | What custom integrations CANNOT do |
|---|---|---|
| **Resource type** | IAM identities, devices, vulnerabilities, risk scenarios, evidence files, custom resource types | Person / HR records (jobTitle, department, employmentStatus, manager) |
| **Vanta surface** | Build Integrations PUT, Manage Vanta write, document upload | None — no write API exposed |
| **Typical ask** | "Push from a bespoke source" → yes, build middleware | "Push HR data from a homegrown HRIS" → use a native HRIS connector, SCIM, CSV, or manual UI entry |

The Personnel scenario lives on both sides of that line. The `user_account` resource (IAM-shaped) is fully pushable via Build Integrations. HR-shaped data on the Person entity is structurally not pushable via any API.

Extending Vanta with a bespoke HR system therefore solves **half** the problem via custom integration (Access Reviews on user_account records) and the **other half** via one of Vanta's supported HR ingestion channels.

### Why this matters

Two categories of data flow into Vanta. The first — IAM identities, device inventory, risk records, evidence files — can be pushed via a custom integration. That is what LlamaLync demonstrates with People-X → user_account: bespoke HRIS, custom middleware, full push. The second — Person and HR data with jobTitle, department, manager hierarchy — has no custom-integration path at all. Vanta deliberately keeps HR data authoritative-from-the-HRIS, structurally. If your HRIS is not on the native connector list, the answer is HRIS-connector feasibility, SCIM provisioning, CSV upload, or manual entry — not "build middleware for it."

---

## 1. Customer archetype + pain

**Archetype:** mid-market or enterprise organization that runs a homegrown HRIS or a bespoke employee directory that Vanta does not have a native connector for. The directory predates Vanta adoption by years, often wired into other internal systems (single-sign-on, internal apps, ticket assignment), and migration off it is impractical.

**The original ask:**
> "We need our employee data in Vanta — we don't use a major HRIS, we have our own thing."

**What "employee data" usually means (the bundle the requester has in mind):**

- Login identity (email, account name, MFA status, permission level, active/deactivated)  ← *this is `user_account`*
- HR record (job title, department, employment status, manager, start date)              ← *this is the Person entity*
- Access grants per system (who has access to AWS, GitHub, Stripe, etc.)                 ← *handled by Vanta's native integrations against the actual systems*

Those three buckets are three different Vanta surfaces with three different write models.

**Pain points the Personnel scenario directly addresses:**

- **Access Reviews against bespoke systems** — Vanta's Access Review module needs user records to ask "should this person still have access?" If the system isn't native, the user records aren't in Vanta, and Access Reviews skip it. Custom user_account push fills that gap.
- **Audit trail of "who has access where"** — auditors expect to see the full IAM picture across all systems. Custom user_account fills the bespoke-system slices.

**Pain points NOT addressable via custom integration:**

- **HR field push (jobTitle / department / managerEmail)** — no API path. Use a native HRIS connector or accept manual entry.
- **Person entity creation from a custom HRIS** — same — no API path.

---

## 2. Mock source system

**Module:** `src/mockHris/` (the original mock — the People-X / Risk-X / CMDB-X / Evidence-X naming pattern started here)

**Mock data:** `mock-data/employees.json` — 6 records spanning:

- 4 active employees (Alice / Bob / Carol / Maria)
- 1 service account (CI Bot)
- 1 terminated employee (Dan)

Each record carries: `id`, `firstName`, `lastName`, `email`, `title`, `department`, `startDate`, `status` (`active` / `terminated`), `isServiceAccount`, `managerId`. The `title` / `department` / `managerId` fields exist in the source — they just have no API path into Vanta.

**Mutation routes:** `POST /mock-peoplex/employees` (Hire), `POST /mock-peoplex/employees/:id/offboard` (Offboard), `POST /mock-peoplex/reset`. Mutations are session-only.

---

## 3. Vanta API surface — what custom integrations CAN and CANNOT do

### `user_account` (Build Integrations push) — WORKS

`PUT /v1/resources/user_account` with `{ resourceId, resources: [...] }`. Full-snapshot semantics — anything not in the payload gets soft-deleted on the next sync.

Required fields per JTD (Dev Console Schema view + cross-reference): `displayName`, `uniqueId`, `externalUrl`, `fullName`, `accountName`, `email`, `permissionLevel`, `createdTimestamp`, `status`, `mfaEnabled`, `mfaMethods`, `authMethod`. Plus `customProperties` per the JTD — but **`customProperties` is rejected at runtime** (verified empirically; see [build-log.md](../build-log.md) "Personnel HR enrichment — there's no API path").

Optional: `roleDescription`, `updatedTimestamp`, `deactivatedTimestamp`, `lastLoginTimestamp`, `lastPasswordResetTimestamp`, `groupIds`.

### People entity (Manage Vanta) — NO HR WRITES

`GET /v1/people` reads the People catalog. `PATCH /v1/people/{id}` exists as a route but **rejects every HR field** as `"X is an excess property and therefore is not allowed"`:

- `employment.jobTitle`, `employment.department`, `employment.employmentStatus`, `employment.employmentType` — all rejected
- All three manager-shape candidates (`{ managerEmail }` top-level, `{ employment: { managerEmail } }`, `{ manager: { email } }`) — all rejected
- Top-level `emailAddress`, `groupIds`, `leaveInfo` — also rejected (follow-up probe)

The only writable surface on `PATCH /v1/people/{id}` is `{ name: { first, last } }` together — manual name corrections only. See [build-log.md](../build-log.md) "People PATCH" for the full probe findings.

### `customProperties` on user_account — REJECTED at runtime

The JTD schema lists `customProperties` as required on user_account (and on Computer resources). The runtime validator rejects it with `"Too many fields on resource with uniqueId X (element 0). Extra keys: customProperties"`. Verified empirically — this behavior is identical between user_account and Computer (same code path, same rejection idiom). The published JTD and the runtime validator disagree for this field across the resource family.

### What this leaves

The pushable surface is `user_account` minus customProperties. That's:
- IAM identity (uniqueId, email, fullName, accountName, externalUrl)
- Auth posture (permissionLevel, mfaEnabled, mfaMethods, authMethod, status)
- Timestamps (createdTimestamp, lastLoginTimestamp, lastPasswordResetTimestamp)
- Group references (groupIds, when relevant)

That's a complete IAM picture — enough to drive Access Reviews. It's NOT enough to drive HR-shaped reporting.

---

## 4. Sync algorithm

Full-snapshot PUT semantics.

```text
1. Read People-X via mockHris.loadEmployees() → array of source rows
2. Filter to active non-service-account employees
3. transformEmployee(emp) per row → user_account-shaped payload
4. PUT /v1/resources/user_account with { resourceId, resources: [...] }
5. Vanta processes full-snapshot:
     - Existing records absent from payload → deletedAt set
     - New records present → created
     - Existing records present → updated
```

Defensive: as with all full-snapshot PUTs, an empty `resources` array
soft-deletes every record under that resourceId. A defensive minimum-record
check is a recommended hardening item shared across personnel / devices.

---

## 5. UI tab structure

The Personnel tab shows:
- **Source: People-X roster** — active employees with title / department / manager visible in the source table (these are NOT pushed to Vanta)
- **In Vanta: pushed user_account records** — what made it into Vanta via the Build Integrations push

Action buttons: Hire / Offboard / Sync All. Same shape as Risk / Devices / Evidence tabs.

A possible UX improvement is to add columns for HR field state (jobTitle / department / managerEmail surfaced from the source roster, marked "not pushed to Vanta — HR has no API path"). See §9.

---

## 6. Key points

1. **Two categories, one push, one not.** Custom integrations push IAM
   identity into Vanta. Custom integrations cannot push HR fields. Same
   bespoke HRIS, same ask, two different answers depending on which
   slice is needed. Get this on the table early.

2. **The validator IS the architecture.** Vanta's runtime validator
   rejects HR fields across three different write paths — PATCH People,
   user_account top-level, user_account customProperties. That is not
   missing functionality, it is structural enforcement. Vanta treats HRIS
   as authoritative-from-source-of-record; the validator's job is to
   keep API callers from overwriting that ground truth. The `sources`
   field on each Person record makes the provenance visible.

3. **What to do for HR data.** Three channels: native HRIS connector if
   the HRIS is supported (Workday, BambooHR, Rippling, etc.), SCIM if
   the IdP does HR provisioning (Okta, Entra ID), or CSV upload through
   the Vanta UI for one-time loads. Manual entry is the fallback. If
   none of those fit, the gap is real — but it is not a custom-
   integration conversation.

4. **What custom DOES solve.** Access Reviews on bespoke systems —
   homegrown HR app, internal IT system, any system Vanta does not have
   a native connector for. `user_account` is the right shape. Expect
   "employee data" to mean the IAM slice, not the HR slice.

5. **Failure mode to avoid: assuming HR push will work.** If the question
   is "can we push jobTitle and department from our system?" the honest
   answer is no — there is no API surface for it. Surface the limit up
   front and explore HRIS-connector feasibility in parallel.

---

## 7. Gotchas / limitations

1. **`customProperties` is REJECTED on user_account.** Despite the JTD
   schema declaring it required. Don't send it. The existing
   `personnelSync.transformEmployee` deliberately omits it (verified
   empirically). Same rejection behavior on Computer resources — see
   [build-log.md](../build-log.md) "Computer resources — what's different".

2. **Full-snapshot PUT semantics.** A PUT with `resources: []`
   soft-deletes every user_account under that resourceId. A defensive
   minimum-record check is a recommended hardening item (parallel to
   the same item flagged in the Devices and Risk scenarios — not yet
   enforced in any of them).

3. **No public DELETE for Person records.** Once an HRIS connector or
   SCIM provider creates a Person record, cleanup is manual via the UI.
   The user_account side of the same employee is fine — full-snapshot
   semantics handle that automatically.

4. **`permissionLevel` enum is tight.** `ADMIN / EDITOR / BASE` only
   (verified via JTD; the earlier empirical probe only confirmed ADMIN
   and BASE). Don't send `USER`, `STANDARD`, `OWNER`, `NORMAL`, etc. —
   400 with `"must be equal to one of the allowed values"`.

5. **`status` enum is also tight.** `ACTIVE / DEACTIVATED`. Integrations
   that source a more granular status (`on-leave`, `pending`, etc.) must
   collapse to ACTIVE or DEACTIVATED before push.

---

## 8. Verified behavior

- **Does PUT /v1/resources/user_account work end-to-end?** Yes — this is
  the foundational scenario.
- **Does PATCH /v1/people/{id} accept HR fields?** No — confirmed against
  the API that every HR field rejects as "excess property".
- **Does customProperties on user_account accept HR fields as a
  fallback?** No — confirmed against the API that the runtime validator
  rejects customProperties on user_account identically to Computer
  resources.

The HR ingestion gap is structural — no API path exists.

---

## 9. Possible future work

These could improve the integration surface but don't change the
architectural answer:

- **Surface "HR fields visible in source, NOT pushed" on the dashboard
  Personnel tab.** Add a small badge or column showing jobTitle /
  department / managerEmail from the People-X roster with a tooltip
  "Visible in People-X. No API path into Vanta — see scenarios/personnel.md."
  Makes the gap visually concrete.
- **Add an "HR ingestion options" panel** to the Personnel tab. Lists the
  four supported channels (native HRIS / SCIM / CSV / manual) with quick
  pointers.
- **Surface the `sources` field from `/v1/people` GET** for an existing
  Person record on the dashboard. Lets the UI point at concrete
  provenance enforcement (Vanta tracks where every field came from).

---

## Sources

- People probe: [`src/scripts/probePeopleApi.js`](../../src/scripts/probePeopleApi.js)
  + [build-log.md "People PATCH — what's different"](../build-log.md)
- Smoke test (user_account.customProperties rejection):
  [build-log.md "Personnel HR enrichment — there's no API path"](../build-log.md)
- user_account JTD schema: [build-log.md "Computer resources — what's
  different" → "user_account schema cross-reference"](../build-log.md)
- Vanta HRIS connector catalog:
  https://www.vanta.com/integrations (filter to HRIS)
