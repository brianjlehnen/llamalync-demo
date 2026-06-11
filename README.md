# LlamaLync

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/brianjlehnen/llamalync-demo)

A Node.js reference architecture for pushing data from bespoke source systems
into Vanta and reading compliance state back out. Built for engineers whose
organizations have on-prem or homegrown systems that Vanta doesn't natively
support.

The bundled mock modules stand in for real source systems so you can run the
full demo without wiring up your own first:

- **People-X** — mock HRIS. LlamaLync polls it, transforms records, and
  pushes them to Vanta as `user_account` resources for Access Reviews.
- **CMDB-X** — mock asset inventory. Pushed to Vanta's
  platform-specific resource types — `MacosUserComputer` and
  `WindowsUserComputer`. Linux devices surface as "unsupported source row"
  because Vanta has no native Linux base resource type.
- **Risk-X** — mock risk register. List-and-diffed into Vanta risk
  scenarios through the Manage Vanta API.
- **Evidence-X** — mock file store. Uploads to Vanta's pre-defined
  document slots (`POST /v1/documents/{slot}/uploads`, multipart) —
  Vanta documents are a fixed catalog of evidence-request slots
  defined by your compliance program, not arbitrary uploads.
- **Workflow Sink** — mock downstream destination. Receives webhook
  events forwarded from Vanta and represents what a customer's
  compliance workflow system (Jira / Linear / Slack / GRC queue) would
  consume.

> **Status: reference architecture, not a packaged product.** Personnel,
> Devices, Evidence, and Risk scenarios are live end-to-end. Webhook
> receive + forward is live. Vulnerability push is scaffolded but
> disabled. Fork it, swap the mock modules for your real systems,
> deploy in your environment.

For integration-pattern notes see [`docs/build-log.md`](./docs/build-log.md).
For per-scenario walkthroughs see [`docs/scenarios/`](./docs/scenarios/).

---

## Prerequisites

- **Node.js ≥ 18.** The repo's `.nvmrc` pins to a recent LTS; `npm install`
  will refuse to proceed on older runtimes. Run `nvm use` (or upgrade) before
  `npm install` if you manage Node versions per-project.
- **A Vanta tenant** where you have **admin access** to the Developer
  Console. If you don't, ask your Vanta admin to grant it, or use a
  sandbox tenant for first-run experimentation before pointing this at
  production.
- Familiarity with reading Node/JavaScript source helps if you intend to
  swap the mock modules for real adapters, but isn't required to run the
  demo.

---

## How LlamaLync talks to Vanta — two surfaces, two apps

Vanta's API splits into two surfaces, and LlamaLync uses **both**. An app of
one type cannot reach the other surface — this is by design, for
least-privilege.

| Surface | App type in Developer Console | What it does | LlamaLync scenarios |
|---|---|---|---|
| **Build Integrations** | Build Integrations (Private distribution) | Push *custom* resources INTO Vanta — `user_account`, `MacosUserComputer`, `WindowsUserComputer`, and upload evidence-document files | Personnel, Devices, Evidence |
| **Manage Vanta** | Manage Vanta | Read / write Vanta's *native* entities — controls, tests, vulnerabilities, people, risk scenarios | Risk, Compliance |

Both apps use the simpler `client_credentials` OAuth grant — **no user-consent
redirect flow** is required for either, because they're operating against your
own tenant rather than as a partner integration. Tokens are 1-hour TTL;
LlamaLync caches and refreshes them automatically.

Reference docs:
[Manage Vanta quickstart](https://developer.vanta.com/docs/quickstart/manage-vanta)
·
[Private Build Integrations quickstart](https://developer.vanta.com/docs/quickstart/build-private-integration)

---

## Setting up your Vanta apps

Both apps are created in **Settings → Developer Console** of the Vanta tenant
you want LlamaLync to write to.

> **Visual walkthrough.** Vanta's own quickstart docs include screenshots of
> every step below; refer to them alongside this README if the prose isn't
> enough on its own:
> - [Private Build Integrations quickstart](https://developer.vanta.com/docs/quickstart/build-private-integration)
> - [Manage Vanta quickstart](https://developer.vanta.com/docs/quickstart/manage-vanta)

### 1. Build Integrations app (Private)

1. **Developer Console → Create** → app type **Build Integrations** →
   distribution **Private**.
2. Name it (e.g. "LlamaLync Sync"). The `client_id` is auto-generated.
3. Click **Generate client secret** to create the secret. Copy both
   values — these become `VANTA_BUILD_CLIENT_ID` and `VANTA_BUILD_CLIENT_SECRET`.
4. Copy the **Integration ID** — this is shown in the Developer Console
   URL (`https://app.vanta.com/developer/apps/<integration-id>`) or in the
   apps list next to the app's name. It becomes `VANTA_INTEGRATION_ID`.
5. Enable the four scopes LlamaLync uses (enable all four when creating
   the app — Build Integrations Private scopes are configured at app
   creation, not at OAuth-token time):
   - `connectors.self:read-resource` + `connectors.self:write-resource`
     (Personnel + Devices)
   - `self:read-document` + `self:write-document` (Evidence)

#### Declare three resources

LlamaLync pushes three resource types. Each must be declared in your app.

In the app's **Resources** tab → **Add resource** → pick a base type → save
→ copy the generated **Resource ID** into the env var:

| Base type | env var |
|---|---|
| `UserAccount` | `VANTA_PERSONNEL_RESOURCE_ID` |
| `MacosUserComputer` | `VANTA_MACOS_RESOURCE_ID` |
| `WindowsUserComputer` | `VANTA_WINDOWS_RESOURCE_ID` |

> **Linux is not in the dropdown.** Vanta has no native Linux base
> resource type. CMDB-X Linux source rows surface in the dashboard as
> "unsupported source row" and are excluded from any PUT.

> **Tip:** the Resources tab's **Schema** button on each resource
> exposes the JTD shape Vanta validates against. Reach for it before
> iterating PUTs — schema view is instant, probing is minutes per
> resource. See [`docs/build-log.md`](./docs/build-log.md) "Computer
> resources — what's different" for the JTD vs JSON Schema notes.

### 2. Manage Vanta app

1. **Developer Console → Create** → app type **Manage Vanta**.
2. Name it (e.g. "LlamaLync Insights").
3. Copy the `client_id` → `VANTA_MANAGE_CLIENT_ID`.
4. Click **Generate client secret** → `VANTA_MANAGE_CLIENT_SECRET`.

Scopes for Manage Vanta apps are requested **at OAuth token time**, not at app
creation. LlamaLync requests `vanta-api.all:read vanta-api.all:write`:
- `:read` for the Compliance dashboard (controls, tests, vulns, people)
- `:write` for the Risk scenario (`POST` / `PATCH /v1/risk-scenarios`)

### 3. Env vars summary

After completing the steps above, you'll fill these into `.env`:

| Variable | Source |
|---|---|
| `VANTA_BUILD_CLIENT_ID` / `VANTA_BUILD_CLIENT_SECRET` | Build Integrations app — Developer Console |
| `VANTA_INTEGRATION_ID` | Build Integrations app's URL or apps list |
| `VANTA_PERSONNEL_RESOURCE_ID` | Build Integrations app → Resources tab → `UserAccount` row |
| `VANTA_MACOS_RESOURCE_ID` | Build Integrations app → Resources tab → `MacosUserComputer` row |
| `VANTA_WINDOWS_RESOURCE_ID` | Build Integrations app → Resources tab → `WindowsUserComputer` row |
| `VANTA_MANAGE_CLIENT_ID` / `VANTA_MANAGE_CLIENT_SECRET` | Manage Vanta app — Developer Console |
| `VANTA_RISK_REGISTER` | Vanta UI → Risk Management → top-of-page register list (usually `Default`) |
| `VANTA_TENANT_NAME` | Subdomain in your Vanta URL (e.g. `acme-corp`) |
| `LLAMALYNC_PASSWORD` | Set this yourself; gates the dashboard login page |
| `LLAMALYNC_SESSION_SECRET` | Generate with `openssl rand -hex 32`; required in production |
| `VANTA_WEBHOOK_SECRET` | Vanta UI → Settings → Webhooks → endpoint signing secret (only needed for the Events scenario) |

See [`.env.example`](./.env.example) for the full list with inline notes.

---

## Local setup

```bash
git clone https://github.com/brianjlehnen/llamalync-demo.git llamalync
cd llamalync
nvm use                   # if you use nvm — pins to Node 18+
npm install
cp .env.example .env      # fill in the values from "Setting up your Vanta apps" above
npm run check:auth        # smoke-test both OAuth tokens
npm start                 # serves the dashboard on http://localhost:3000
```

### Expected `check:auth` output

```
[INFO] Build Integrations auth OK   token vat_…  (expires in 3600s)
[INFO] Manage Vanta auth OK         token vat_…  (expires in 3600s)
```

If either line fails, see [Troubleshooting](#troubleshooting).

### First-run walkthrough

Local dashboard auth is **disabled by default** when `LLAMALYNC_PASSWORD` is
unset. Set the password to enable the styled login page — required for any
hosted deployment.

After `npm start`, hit `http://localhost:3000`:

1. The dashboard opens on **Overview** with five scenario tiles, all reading
   `0 / 0 / 0`. That's expected — no syncs have run yet.
2. Open **Personnel** → click **Sync Now**. A toast confirms
   `Synced N records to Vanta` within ~2s.
3. Verify in your Vanta tenant: **Settings → Integrations → your Build
   Integrations app → Resources → UserAccount → Records**. The N records
   you just pushed should appear.
4. Repeat for **Devices** and **Evidence** to exercise the Build Integrations
   surface, and **Risk** for Manage Vanta.
5. Open **Developer → Activity** to see the wire-level Vanta API calls
   LlamaLync made.

The dashboard's per-scenario **Guide** disclosure (top-right of each tab)
walks through that tab's actions and the architectural lesson.

---

## Deploy to Render

`render.yaml` defines a free-tier web service. After forking the repo to your
own GitHub account:

1. **Complete "Setting up your Vanta apps" first.** You'll need all the
   values from it before Render can run a healthy instance.
2. Push your fork to GitHub.
3. Render dashboard → **New** → **Blueprint** → connect your GitHub repo.
4. Render reads `render.yaml` and prompts for the env vars marked
   `sync: false`. Paste the values from your `.env`:
   - All four `VANTA_BUILD_*` / `VANTA_MANAGE_*` credentials
   - `VANTA_INTEGRATION_ID`, `VANTA_PERSONNEL_RESOURCE_ID`,
     `VANTA_MACOS_RESOURCE_ID`, `VANTA_WINDOWS_RESOURCE_ID`
   - `VANTA_RISK_REGISTER` (usually `Default`)
   - `VANTA_TENANT_NAME`, `VANTA_ENV` (`sandbox` or `production` —
     drives the header ribbon color)
   - `LLAMALYNC_PASSWORD`
   - `VANTA_WEBHOOK_SECRET` (only if you wire up webhooks)
5. `LLAMALYNC_SESSION_SECRET` is set automatically by Render
   (`generateValue: true` in `render.yaml`) — leave that prompt alone.
6. Deploy. Free-tier cold starts are 15–20s; fine for a demo / reference
   environment.

Once deployed, the dashboard is at `https://<your-render-name>.onrender.com/`.
The login page accepts the password you set in `LLAMALYNC_PASSWORD`. Session
cookies are 24h TTL; the icon top-right signs you out.

---

## Scenarios

| Tab | Surface | What it shows | Detailed doc |
|---|---|---|---|
| **Personnel** | Build Integrations | Homegrown HRIS → `user_account` push | [`scenarios/personnel.md`](docs/scenarios/personnel.md) |
| **Devices** | Build Integrations | Homegrown CMDB → `MacosUserComputer` + `WindowsUserComputer` push | [`scenarios/devices.md`](docs/scenarios/devices.md) |
| **Evidence** | Build Integrations | Local file store → evidence-document slot uploads | [`scenarios/evidence.md`](docs/scenarios/evidence.md) |
| **Risk** | Manage Vanta WRITE | Homegrown risk register → Vanta risk scenarios | [`scenarios/risk.md`](docs/scenarios/risk.md) |
| **Compliance** | Manage Vanta READ | Tenant compliance state — controls / tests / vulns / people | (read-only summary in the dashboard) |
| **Events** | Webhook receiver | Real-time Vanta webhook → Workflow Sink forwarding | [`scenarios/webhooks.md`](docs/scenarios/webhooks.md) |

---

## Manual scripts

```bash
npm run check:auth        # verify both OAuth tokens against Vanta
npm run sync:personnel    # push personnel snapshot to Vanta (no server needed)
npm run sync:risk         # list-and-diff Risk-X into Vanta risk scenarios
npm run sync:devices      # push CMDB-X computer snapshot (macOS + Windows; Linux excluded)
npm run sync:evidence -- <filename> [slotId]   # upload one evidence file to a slot
npm run dev               # nodemon — auto-restart on file changes
npm test                  # full test suite (no Vanta calls)
```

Scheduled (cron) syncs run automatically in `NODE_ENV=production`. Locally,
set `ENABLE_SCHEDULER=true` to opt in — otherwise no scheduled writes happen
in dev.

---

## Troubleshooting

### `check:auth` fails with `401 Unauthorized`
- The `client_id` / `client_secret` pair doesn't match a real app. Re-copy from the Developer Console.
- For the Build Integrations app: confirm distribution is **Private**. Public-distribution apps use a different OAuth flow that requires a redirect URI.
- For the Manage Vanta app: confirm the app exists in the same tenant whose subdomain you've set in `VANTA_TENANT_NAME`.

### `check:auth` fails with `403 Forbidden`
- App scopes are missing. For Build Integrations: confirm
  `connectors.self:read-resource` + `connectors.self:write-resource`
  (+ `self:read-document` + `self:write-document` for Evidence) are
  enabled. For Manage Vanta: scopes are requested at token time —
  LlamaLync requests `vanta-api.all:read vanta-api.all:write`; if your
  Manage app was created with a narrower scope grant, expand it.

### Sync fails with `422 Invalid fields (riskRegister)`
- `VANTA_RISK_REGISTER` is unset or doesn't match a register name in
  your tenant. Find it in **Vanta UI → Risk Management → top-of-page
  register list**. `Default` is the typical single-register name.

### Sync fails with `404 Not Found`
- `VANTA_*_RESOURCE_ID` env var is stale or mistyped. Re-copy from your
  Build Integrations app's **Resources** tab.

### Dashboard header shows "tenant unconfigured"
- `VANTA_TENANT_NAME` is unset. Set it to your tenant's subdomain (the
  segment between `https://app.vanta.com/` and the next slash in your
  Vanta UI URL).

### Webhooks endpoint returns `503 Service Unavailable`
- `VANTA_WEBHOOK_SECRET` is unset. Either set it (after configuring the
  webhook in **Vanta UI → Settings → Webhooks** pointing at
  `https://<your-host>/webhooks/vanta`) or accept that the Events
  scenario will be inactive until you do.

### Rate-limited (`429 Too Many Requests`)
- Build Integrations is 20 req/min, Manage Vanta is 50 req/min.
  LlamaLync backs off and retries automatically, but firing manual sync
  triggers in tight succession can hit the ceiling. Wait a minute and
  retry.

---

## Extending — swap mocks for real source systems

Each mock module is a thin module exporting `loadX()` returning
`{ data, lastModified, mutationCount }`. To wire LlamaLync into your real
systems, replace the mock with an adapter that exposes the same interface:

| Mock | Replace with adapter for |
|---|---|
| [`src/mockHris/`](src/mockHris/) | Your HRIS / employee directory |
| [`src/mockCmdb/`](src/mockCmdb/) | Your CMDB / asset inventory |
| [`src/mockRiskRegister/`](src/mockRiskRegister/) | Your risk register |
| [`src/mockEvidenceStore/`](src/mockEvidenceStore/) | Your evidence file store |
| [`src/mockWorkflowSink/`](src/mockWorkflowSink/) | Your downstream workflow system (Jira / Slack / Linear / GRC queue) |

The sync jobs in [`src/sync/jobs/`](src/sync/jobs/) consume the same shape —
point your adapter at it and the sync logic is unchanged.

---

## Endpoint reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | HTML dashboard |
| `GET` | `/dashboard.json` | Same data as the dashboard, in JSON |
| `GET` | `/requests.json` | Recent Vanta API call log (in-memory ring buffer) |
| `GET` | `/health` | Health check (auth-exempt) |
| `GET` | `/mock-peoplex/employees.json` | Fake HRIS source data |
| `GET` | `/mock-peoplex/_meta.json` | Source breakdown for the dashboard |
| `POST` | `/mock-peoplex/employees` | Add a synthetic new hire |
| `POST` | `/mock-peoplex/employees/:id/offboard` | Mark an employee terminated |
| `POST` | `/mock-peoplex/reset` | Reset People-X session mutations to baseline |
| `GET` | `/mock-riskx/risks.json` | Fake Risk-X source register |
| `GET` | `/mock-riskx/_meta.json` | Risk-X source breakdown for the dashboard |
| `POST` | `/mock-riskx/risks` | Add a synthetic new risk |
| `POST` | `/mock-riskx/risks/:id/apply-treatment` | Apply residual scoring / mitigation text in Risk-X |
| `POST` | `/mock-riskx/risks/:id/close` | Mark a risk closed in Risk-X |
| `POST` | `/mock-riskx/reset` | Reset Risk-X session mutations to baseline |
| `GET` | `/mock-cmdbx/devices.json` | Fake CMDB-X source asset inventory |
| `GET` | `/mock-cmdbx/_meta.json` | CMDB-X source breakdown for the dashboard |
| `POST` | `/mock-cmdbx/devices` | Onboard a synthetic new device |
| `POST` | `/mock-cmdbx/devices/:id/decommission` | Mark a device decommissioned in CMDB-X |
| `POST` | `/mock-cmdbx/devices/:id/reassign` | Reassign device owner; body: `{ "assignedEmployeeId": "emp-XXX" \| null }` |
| `POST` | `/mock-cmdbx/reset` | Reset CMDB-X session mutations to baseline |
| `GET` | `/mock-evidencex/files.json` | Fake Evidence-X manifest (files + target slot mappings) |
| `GET` | `/mock-evidencex/_meta.json` | Evidence-X source breakdown |
| `GET` | `/mock-evidencex/files/:filename` | Binary read of one evidence file (allow-listed against manifest) |
| `POST` | `/mock-evidencex/reset` | Clear in-session upload history |
| `POST` | `/sync/personnel` | Trigger a personnel sync to Vanta |
| `POST` | `/sync/risk` | Trigger a Risk-X → Vanta risk-scenario sync |
| `POST` | `/sync/devices` | Trigger a CMDB-X → Vanta computer sync (full-snapshot PUT per platform; Linux excluded) |
| `POST` | `/sync/evidence` | Upload one evidence file to a Vanta document slot; body: `{ "filename": "...", "slotId"?: "...", "description"?: "...", "effectiveAtDate"?: "YYYY-MM-DD" }` |
| `POST` | `/sync/vulns` | Scaffolded; returns `501` until the Vanta vulnerability schema is verified |
| `POST` | `/demo/reset/personnel` | Reset for next run — empty `user_account` PUT to Vanta + People-X mock back to baseline |
| `POST` | `/demo/reset/devices` | Reset for next run — empty `Macos`/`WindowsUserComputer` PUTs to Vanta + CMDB-X mock back to baseline |
| `POST` | `/demo/reset/risk` | Reset Risk-X mock to baseline. Vanta risk-scenarios have no DELETE endpoint — response includes a `manualCleanupHint` for the UI toast |
| `POST` | `/demo/reset/evidence` | Reset Evidence-X session upload history. Slot-bound documents have no DELETE endpoint — response includes a `manualCleanupHint` |
| `POST` | `/webhooks/vanta` | Vanta webhook receiver (HMAC-verified, auth-exempt) |
