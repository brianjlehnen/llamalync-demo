# Devices / CMDB-X — design spec

**Customer-facing system name:** CMDB-X (homegrown asset inventory, mirrors the People-X / Risk-X naming).

---

## 0. The architectural twist

**Devices push via Build Integrations — like Personnel, NOT like Risk.** And the
twist within that twist: Vanta exposes **two separate, platform-specific** computer
resource types, not one generic "Computer". Plus Linux has no native base type at
all, so the integration has to surface the gap rather than silently hide it.

| | Personnel | Risk | Devices (this scenario) |
|---|---|---|---|
| Vanta API surface | Build Integrations | Manage Vanta | Build Integrations |
| Credential | `buildAuth` (`connectors.self:*`) | `manageAuth` (`vanta-api.all:*`) | `buildAuth` |
| Endpoint(s) | `PUT /v1/resources/user_account` | `POST` / `PATCH /v1/risk-scenarios` | `PUT /v1/resources/MacosUserComputer` AND `PUT /v1/resources/WindowsUserComputer` |
| Rate limit | 20 req/min | 50 req/min | 20 req/min (shared with personnel) |
| Identifier | source-system `uniqueId` | Vanta's `riskScenarioId` / source-system `riskId` | source-system `uniqueId` |
| Snapshot semantics | Full-snapshot PUT; missing rows soft-deleted | Per-record create / update | Full-snapshot PUT per platform; missing rows soft-deleted within each platform |
| Owner field on resource | n/a | `owner` (string) | `owner` (string, nullable) — same name as Risk |
| Schema strictness | JTD, strict, required + optional | n/a (Manage Vanta surface) | JTD, strict, required + optional (confirmed against the API) |

### Why this matters

Devices use the same push surface as Personnel — Build Integrations, full-snapshot
PUT, source → Vanta. Two material differences from Personnel: first, Vanta has
distinct schemas for macOS and Windows endpoints; writes go to `MacosUserComputer`
and `WindowsUserComputer` separately. Second, Linux is not a native resource type at
all — there is no `LinuxUserComputer`. The integration deliberately surfaces Linux
devices as "unsupported source rows" in the dashboard so auditors can see exactly
which fleet members fall outside Vanta's native coverage. That is the strongest
compliance-gap signal in this scenario.

---

## 1. Customer archetype + pain

**Archetype:** mid-market or enterprise organization running a homegrown / on-prem
asset inventory that Vanta has no native connector for. Most common shapes:

- **ServiceNow CMDB** — Vanta's native ServiceNow connector covers ITSM/change
  management ONLY. CMDB data is out of scope; device inventory from ServiceNow
  lands in this scenario.
- **Internal asset databases** — bespoke web apps tracking laptop assignments
  built before adoption of a real ITSM tool. Often the source of truth
  for "who has what."
- **On-prem MDM with no API integration** — Jamf or Intune deployments that
  are not on the native-connector list, or are hosted on-prem behind a
  firewall.
- **Spreadsheets or Airtable** — common in small-to-mid organizations that
  have not formalized asset management yet.

**Pain points:**

- **Audit prep re-keying** — manual export-and-upload of device evidence per
  asset. Auditors want to see disk encryption, screen lock, MDM enrollment,
  OS version across the fleet. Re-entering this by hand for 200+ devices is
  multi-hour analyst work, every audit cycle.
- **Orphan devices nobody catches** — a device assigned to an employee who
  left, still in the CMDB with their employeeId pointed at a stale entry.
  Vanta's compliance tests can't surface "this device has no owner"
  if the device isn't in Vanta in the first place.
- **Cross-platform drift** — Mac fleet enrolled in MDM, Windows fleet isn't.
  Without a unified push, the SOC's view of "is our fleet hardened" is
  per-platform-different.
- **Linux + Vanta** — the workstation-Linux developer subset of the fleet
  has no path into Vanta at all today. Customers either skip Linux in their
  compliance program (audit risk) or maintain a manual evidence record (toil).

---

## 2. Mock source system

**Module:** `src/mockCmdb/` (mirrors `src/mockHris/` and `src/mockRiskRegister/`)

**Mock data:** `mock-data/devices.json` — 11 devices designed to span:

- 5 macOS / 4 Windows / 2 Linux
- 3 orphans (1 per OS) — `assignedEmployeeId: null`, surfaces in dashboard as
  the "owner-gap" compliance signal
- Compliance variance: one unencrypted macOS (Maria's VP machine, `isManaged:
  false` + drive `encrypted: false` + `isXProtectEnabled: false`), one
  unmanaged Windows VM with `windowsSecurityCenter.firewall: "POOR"` + bad
  autoupdate + bad internet setting, one stale check-in (>30 days)
- Owner linkage via `assignedEmployeeId` resolved at sync time against the
  People-X roster (`mock-data/employees.json`). Real CMDBs often denormalize
  email instead — both shapes work, but the cross-reference makes the
  identity-resolution path explicit.

**Source row shape (macOS example, abbreviated):**

```json
{
  "id": "DEV-MAC-001",
  "hostname": "alice-macbook-pro",
  "serialNumber": "C02XG2JHJGH5",
  "os": "macOS",
  "osVersion": "14.2.1",
  "hardwareUuid": "8F4D3C2B-...",
  "assignedEmployeeId": "emp-001",
  "lastSeen": "2026-05-13T08:30:00Z",
  "status": "active",
  "isManaged": true,
  "autoUpdatesEnabled": true,
  "applications": [
    { "name": "Slack", "bundleId": "com.tinyspeck.slackmacgap", "lastOpenedAt": "..." }
  ],
  "browserExtensions": [...],
  "drives": [{ "name": "Macintosh HD", "encrypted": true, "filevaultEnabled": true, "isBootVolume": true }],
  "users": [...],
  "systemScreenlockPolicies": [...],
  "passwordPolicy": { "minimumLengthRequirement": 12 },
  "lastEnrolledAt": "2024-03-15T10:00:00Z",
  "isXProtectEnabled": true
}
```

Windows source rows substitute `programs` (no bundleId) for `applications`,
add `windowsSecurityCenter` + `windowsSecurityProducts`, and drop
`filevaultEnabled` from drives. Linux source rows are intentionally lean —
they aren't pushed, just surfaced in the dashboard.

---

## 3. Vanta API surface (verified empirically)

**Endpoints** (per the Dev Console Schema view + [build-log.md](../build-log.md)
"Computer resources — what's different"):

| Operation | Endpoint | Notes |
|---|---|---|
| List macOS computers | `GET /v1/resources/MacosUserComputer?resourceId=...` | For drift-check / dashboard reads |
| Push macOS snapshot | `PUT /v1/resources/MacosUserComputer` | Full-snapshot; body `{ resourceId, resources }` |
| List Windows computers | `GET /v1/resources/WindowsUserComputer?resourceId=...` | |
| Push Windows snapshot | `PUT /v1/resources/WindowsUserComputer` | Full-snapshot; body `{ resourceId, resources }` |

**Path naming is exact-case** — `MacosUserComputer`, not `macos_user_computer`.
Matches the Dev Console Resources tab dropdown label character-for-character.

**JTD format** — schemas are JSON Type Definition (RFC 8927), NOT JSON Schema.
Semantic differences that matter:

- `properties` = REQUIRED object members (not "all properties")
- `optionalProperties` = optional object members
- Strict by default — unknown keys are rejected
- `elements` = array item shape
- `enum: [...]` = closed enumeration
- `nullable: true` allows null in addition to the declared type
- Primitives: `string`, `boolean`, `int32`, `timestamp` (RFC 3339)

### Schema diff: MacosUserComputer vs WindowsUserComputer

15 of 16 required fields are shared. The diff:

| Field | macOS | Windows |
|---|---|---|
| App inventory key | `applications` | `programs` |
| App inventory required item fields | `name`, `bundleId` | `name` only — **no `bundleId`** |
| `drives[]` required item fields | `name`, `encrypted`, **`filevaultEnabled`** | `name`, `encrypted` (no filevault) |
| Platform-specific optionals | `isXProtectEnabled` | `windowsSecurityProducts[]`, `windowsSecurityCenter{...}` |

The Windows-only `windowsSecurityCenter` carries six independent
enum-rated signals (`firewall`, `autoupdate`, `antivirus`, `internetSetting`,
`userAccountControl`, `windowsSecurityCenterService`), each scored
`GOOD / POOR / SNOOZED / NOT_MONITORED / ERROR`. Materially richer than
macOS's single `isXProtectEnabled` boolean. **Surface this prominently in
the dashboard's Devices tab** — it is the strongest visible compliance
signal in this scenario.

### Owner-linkage finding

The `owner` field on both schemas is **`owner`** (string, nullable, optional)
— NOT `ownerEmail`, NOT `externalOwnerEmployeeId`. Same naming as the Risk
scenario's `owner` field. The email value resolves to a Vanta People record
at write time. Unknown emails are accepted leniently for Computer resources
(see §9).

### `customProperties` contract — JTD declares required, validator rejects

The Dev Console JTD schema lists `customProperties` under required
`properties`, but the runtime validator **rejects** it with
`"Too many fields… Extra keys: customProperties"` (verified empirically).
Same divergence as the existing `user_account` resource —
`personnelSync.js` has always omitted it and worked. **CMDB-X transforms
do NOT send `customProperties`**; the field is preserved as a known
schema-vs-validator gap, documented but not exercised. If Vanta later
opens up `customProperties` as a writable extension hook, the transform
can be updated; for now, omit.

---

## 4. Sync algorithm

```text
1. Read CMDB-X mock register → array of source rows
2. Read People-X roster → build emp-id → email map
3. Bucket by os and status:
     - active macOS         → macosPayload  (pushed)
     - active Windows       → windowsPayload (pushed)
     - active Linux         → unsupportedLinuxRows (surfaced, NOT pushed)
     - any decommissioned   → skipped (drops out of full-snapshot, soft-deleted)
4. transformMacosDevice(d) per macOS row; transformWindowsDevice(d) per Windows row
5. PUT /v1/resources/MacosUserComputer with macosPayload (full snapshot)
6. PUT /v1/resources/WindowsUserComputer with windowsPayload (full snapshot)
7. Return stats:
     - pushed.macos, pushed.windows
     - orphans.macos, orphans.windows  (devices with owner === null)
     - skipped.linuxUnsupported, skipped.decommissioned
     - unsupportedLinuxRows[]  (full row data for dashboard rendering)
```

**Defensive minimum-record check (recommended hardening):** the existing
personnel sync does not enforce one either. If the source suddenly returns
zero macOS or zero Windows devices and the previous sync had records, the
PUT would soft-delete the entire platform fleet. Track as a cross-cutting
hardening item.

---

## 5. Linux Go/No-Go — surfaced, not silently dropped

Linux devices are deliberately surfaced in the dashboard as
**"unsupported source row"** rather than silently filtered. The compliance
reasoning:

- An auditor seeing "5 macOS + 4 Windows" might infer the fleet is fully
  covered. Hiding Linux from view masks a real coverage gap.
- An auditor seeing "5 macOS + 4 Windows + 2 Linux (unsupported native
  resource)" knows exactly where Vanta's native coverage ends. They can
  ask the right follow-up: "what compensating evidence do you have for
  those 2 Linux devices?"

The other paths considered and rejected:

- **(a) Drop Linux silently** — hides the gap, misleads auditors. Rejected.
- **(b) Map Linux to a custom resource type** — requires tenant-side schema
  authoring per customer, ongoing maintenance burden, no native compliance
  tests run against it. Worse than option (c) for both demo and real
  customers.

The implementation excludes Linux from any PUT (`runDeviceSync` filters
`os === 'Linux'` to `unsupportedLinuxRows`) and the dashboard surfaces them
as a visible row with a tooltip explaining the gap.

---

## 6. UI tab structure

The `Devices` tab in the dashboard uses the same visual language as Personnel
and Risk:

```text
┌─ Header: CMDB-X → Vanta MacosUserComputer + WindowsUserComputer ──────┐
│  Build Integrations credential. Source-of-truth: CMDB-X.              │
│                                                                       │
│  [ Sync All ]  [ Onboard Device ]  [ Reassign Owner ]  [ Decommission ]│
└──────────────────────────────────────────────────────────────────────────┘

┌─ Source: CMDB-X inventory ─────┐  ┌─ In Vanta: Computers ─────────────┐
│  DEV-MAC-001  alice-macbook    │  │  ☑ DEV-MAC-001  Synced            │
│  DEV-MAC-005  shared-mac-mini  │  │  ⚠ DEV-MAC-005  Orphan (no owner) │
│  DEV-WIN-003  alice-windows-vm │  │  ⚠ DEV-WIN-003  Insecure (POOR)   │
│  DEV-LIN-001  alice-ubuntu     │  │  ✗ Unsupported source row         │
│  DEV-LIN-002  legacy-server    │  │  ✗ Unsupported source row         │
└─────────────────────────────────┘  └────────────────────────────────────┘

┌─ Compliance heat ──────────────────────────────────────────────────────┐
│  9/11 active   3 orphan   2 unencrypted   1 unmanaged                  │
│  2 Linux unsupported (native push)                                     │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Windows Security Center (per-device, Windows only) ──────────────────┐
│  DEV-WIN-001  bob-surface-pro     firewall:GOOD  AV:GOOD  auto:GOOD   │
│  DEV-WIN-003  alice-windows-vm    firewall:POOR  AV:GOOD  auto:POOR ⚠ │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Activity log ───────────────────────────────────────────────────────┐
│  10:14:22  PUT  /v1/resources/MacosUserComputer    → 200             │
│  10:14:21  PUT  /v1/resources/WindowsUserComputer  → 200             │
└──────────────────────────────────────────────────────────────────────────┘
```

### Action behaviors

| Button | What it does |
|---|---|
| **Sync All** | Full-snapshot PUT per platform. Logs each call. |
| **Onboard Device** | Adds a synthetic device from the rotating pool (macOS → Windows → Linux → repeat). Next Sync All pushes it (or, if Linux, surfaces as unsupported). |
| **Reassign Owner** | Reassigns a chosen device's `assignedEmployeeId`. Demonstrates owner-linkage propagation. |
| **Decommission** | Flips device `status` to `decommissioned`. Next Sync All drops it from the full-snapshot PUT; Vanta soft-deletes it. |

The **Windows Security Center panel** is the "richer than macOS" surface —
six per-device enum-rated signals plus per-product state. Color-code the
GOOD / POOR / SNOOZED / NOT_MONITORED / ERROR values so the badly-configured
Windows VM (DEV-WIN-003) stands out at a glance.

---

## 7. Key points

1. **Same push surface as Personnel, different schema family.** Devices is
   Build Integrations, just like the personnel push. The interesting
   difference is that Vanta exposes two platform-specific resource types —
   `MacosUserComputer` and `WindowsUserComputer` — with material schema
   differences. The transform layer has a per-platform branch.

2. **Linux is the strongest gap signal.** There is no native Linux base
   resource type in Vanta's catalog. The dashboard shows Linux devices
   explicitly as "unsupported source row" so the coverage boundary is
   visible. "How do we cover the Linux subset" is a real question with a
   real answer (compensating controls, documented evidence), not something
   to hide behind a silent filter.

3. **Windows Security Center is materially richer than macOS.** The
   Windows schema includes a six-signal Windows Security Center block —
   firewall, autoupdate, antivirus, internet setting, UAC, the WSC
   service itself — each rated GOOD/POOR/SNOOZED. The data is more
   granular on Windows.

4. **JTD, not JSON Schema.** Vanta uses JSON Type Definition for the
   resource schemas. Different from JSON Schema in two ways that matter:
   `properties` means required (not "all properties"), and the validator
   is strict by default — unknown keys 400. No "warn" tolerance. Emit
   exactly the schema, no extras.

5. **The Dev Console exposes the JTD schema directly.** No need to iterate
   PUTs against the API to discover the schema — the Console's Resources
   tab has a Schema button on every Resource that exports the JTD. Check
   that before writing transform code. It gives you the source-of-truth
   shape immediately.

---

## 8. Gotchas / limitations

1. **Path naming is exact-case.** `/v1/resources/MacosUserComputer`, not
   `/v1/resources/macos_user_computer`. Mismatch returns 404. Verified
   empirically.

2. **`uniqueId` is the identity field, NOT `externalId`.** Vanta rejects
   `externalId`; the canonical id field is `uniqueId` (same as
   `user_account`).

3. **`owner` accepts any string on Computer resources.** Verified
   empirically — Computer resources store `owner` as-sent and do NOT
   strictly validate against the People entity (this contrasts with the
   risk-scenario `owner` behavior). The implementation still defaults to
   `owner: null` for any source row whose `assignedEmployeeId` doesn't
   resolve in the People-X roster — defensive, harmless, and the same
   code path handles genuine orphans.

4. **Full-snapshot PUT semantics same as `user_account`.** A PUT with
   `resources: []` soft-deletes every record under that resourceId
   immediately. Defensive minimum-record check is a recommended hardening
   item (parallel to personnel sync — not yet enforced in either).

5. **Decommissioned devices in CMDB-X drop out of the next PUT.** This is
   intentional (the soft-delete-via-PUT-omission pattern): when a device
   disappears from CMDB-X, it disappears from Vanta on the next sync.

6. **`customProperties` is REJECTED at runtime despite the JTD declaration.**
   Verified empirically — the validator returns
   `"Too many fields… Extra keys: customProperties"`. The transform omits
   it. The existing `personnelSync.js` was always right to skip it.

7. **`browserExtensions[].browser` is a closed enum** —
   `CHROME / FIREFOX / OPERA / SAFARI / EDGE`. Other values 400. Mock
   data uses only these five.

8. **No webhook story for Computer resources today.** Vanta does not
   currently fire "computer.updated" webhooks. Sync is one-way (CMDB-X
   → Vanta). Real-time fleet state from Vanta requires a poll loop on the
   Manage Vanta surface or accepting lag.

---

## 9. Verified behavior

These were not answerable from the JTD schema alone, so they were
confirmed against the API. Full write-up in
[`docs/build-log.md`](../build-log.md) "smoke-test findings".

- **`owner` is LENIENT on Computer resources.** Vanta accepts any string
  for `owner` on computer resources and stores it as-sent (read-back
  confirmed every synthetic `*.peoplex.example.com` email was stored
  verbatim; an orphan with `owner: null` was stored as null). This
  **contradicts** the risk-scenario `owner` behavior (which 422s on
  unresolved emails). The implementation's `resolveOwnerEmail()`
  null-defense is over-cautious for this surface but harmless — same
  code path handles genuine orphans. Keep the defense; document the
  asymmetry.

- **`customProperties` is REJECTED at runtime.** Vanta's validator rejects
  `customProperties` with `"Too many fields… Extra keys: customProperties"`
  despite the Dev Console JTD declaring it required. Implementation
  omits it. The existing `personnelSync.js` was always right to skip it.

- **Exact rejected-field error idiom for these resource types.**
  `"Too many fields on resource with uniqueId X. Extra keys: Y, Z"` —
  same idiom as `user_account`.

- **Empty arrays for required array fields** (`applications: []`,
  `browserExtensions: []`, `drives: []`, `users: []`,
  `systemScreenlockPolicies: []`) — not yet exercised; the mock data
  carries non-empty arrays for every device.

- **Read-back round-trips cleanly.** `GET /v1/resources/MacosUserComputer
  ?resourceId={id}` returns `{ resources: [...] }` with stored fields
  intact. The dashboard's "in Vanta" panel can use this verbatim, same
  pattern as
  [`src/reconcile/userAccountReconcile.js`](../../src/reconcile/userAccountReconcile.js).

---

## Sources

- Vanta JTD schemas for `MacosUserComputer` and `WindowsUserComputer` —
  pulled from Dev Console Resources tab Schema button. Captured in
  [`docs/build-log.md`](../build-log.md) "Computer resources — what's
  different".
- Vanta API overview (rate limits, errors):
  https://developer.vanta.com/docs/vanta-api-overview
- Probe findings: `src/scripts/probeComputerApi.js` runs +
  the Dev Console Schema view that superseded the iterative probe approach.
