const express = require('express');
const fs = require('fs');
const path = require('path');
const { buildClient, manageClient, getRequestLog, clearRequestLog } = require('../http/vantaClient');
const { getComplianceSnapshot } = require('../sync/readApi');
const { loadEmployees } = require('../mockHris');
const { loadRisks } = require('../mockRiskRegister');
const { loadDevices } = require('../mockCmdb');
const { loadEvidenceFiles } = require('../mockEvidenceStore');
const { isBeforeOrMissing } = require('../utils/dateHelpers');
const webhookEventStore = require('../webhooks/eventStore');
const mockWorkflowSink = require('../mockWorkflowSink');
const logger = require('../utils/logger');

// The Postman collection parser is shared between node:test (require()) and the
// browser (inlined into the dashboard's <script> block). Read once at module
// load so we don't pay the disk hit per request. Keeps a single source of truth
// for the parser logic — see src/dashboard/explorer/postmanImport.js.
const POSTMAN_IMPORT_JS = fs.readFileSync(
  path.join(__dirname, 'explorer/postmanImport.js'),
  'utf8'
);

/**
 * Reads the simulated People-X HRIS payload — same data the /mock-peoplex
 * endpoint serves. Lets the dashboard show what the source system says
 * vs. what LlamaLync actually pushed (vs. what landed in Vanta).
 */
function getSourceData() {
  try {
    const { data, lastModified, mutationCount } = loadEmployees();
    return {
      total: data.length,
      activeEmployees: data.filter(e => e.status === 'active' && !e.isServiceAccount).length,
      terminated: data.filter(e => e.status === 'terminated').length,
      serviceAccounts: data.filter(e => e.isServiceAccount).length,
      lastModified,
      mutationCount,
      roster: data
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Reads pushed user_account records via the Build Integrations read scope.
 * Filters out soft-deleted records (deletedAt is set on records that fell
 * out of the latest snapshot).
 */
async function getPushedPersonnel() {
  const resourceId = process.env.VANTA_PERSONNEL_RESOURCE_ID;
  if (!resourceId) {
    return { error: 'VANTA_PERSONNEL_RESOURCE_ID not set in .env' };
  }
  try {
    const data = await buildClient.get(`/v1/resources/user_account?resourceId=${resourceId}`);
    const all = data.resources || [];
    const active = all.filter(r => !r.deletedAt);
    const softDeleted = all.filter(r => r.deletedAt);
    return { active, softDeleted };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Reads the simulated Risk-X register — same data the /mock-riskx endpoint
 * serves. Stand-in for a customer's homegrown risk register that Vanta has
 * no native connector for.
 */
function getRiskSource() {
  try {
    const { data, lastModified, mutationCount } = loadRisks();
    const overdueCutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    return {
      total: data.length,
      open: data.filter(r => r.status === 'Open').length,
      closed: data.filter(r => r.status === 'Closed').length,
      untreated: data.filter(r => r.currentMitigations == null).length,
      overdueReview: data.filter(r => r.status === 'Open' && isBeforeOrMissing(r.lastReviewedAt, overdueCutoff)).length,
      lastModified,
      mutationCount,
      risks: data
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Reads risk scenarios currently in Vanta via the Manage Vanta read scope.
 * Different surface from Personnel — risk lives in /v1/risk-scenarios under
 * Manage Vanta, not Build Integrations. Same paginated cursor model.
 */
async function getPushedRiskScenarios() {
  try {
    const all = await manageClient.fetchAllPages('/v1/risk-scenarios');
    return {
      total: all.length,
      risks: all
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Reads the simulated CMDB-X asset inventory — same data the /mock-cmdbx
 * endpoint serves. Stand-in for a customer's homegrown CMDB / asset DB /
 * on-prem MDM that Vanta has no native connector for.
 *
 * Buckets at read time so the dashboard renderers don't repeat the bucketing
 * logic: active vs decommissioned, per-OS counts, orphan + compliance gaps.
 */
function getDeviceSource() {
  try {
    const { data, lastModified, mutationCount } = loadDevices();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const active = data.filter(d => d.status !== 'decommissioned');
    return {
      total: data.length,
      active: active.length,
      decommissioned: data.filter(d => d.status === 'decommissioned').length,
      macos:   active.filter(d => d.os === 'macOS').length,
      windows: active.filter(d => d.os === 'Windows').length,
      linux:   active.filter(d => d.os === 'Linux').length,
      orphans:     active.filter(d => !d.assignedEmployeeId).length,
      unmanaged:   active.filter(d => d.isManaged === false).length,
      unencrypted: active.filter(d => (d.drives || []).some(dr => dr.encrypted === false)).length,
      staleCheckIn30d: active.filter(d => isBeforeOrMissing(d.lastSeen, thirtyDaysAgo)).length,
      lastModified,
      mutationCount,
      devices: data
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Reads pushed computer records via the Build Integrations read scope.
 * Two API calls — one per platform-specific resource type. Filters out
 * soft-deleted records on each platform (same pattern as user_account).
 *
 * Returns { macos: {active, softDeleted, error?}, windows: {...} } so the
 * dashboard renderer can show per-platform stats and degrade gracefully when
 * one read fails without losing the other.
 */
async function getPushedDevices() {
  const macosResourceId   = process.env.VANTA_MACOS_RESOURCE_ID;
  const windowsResourceId = process.env.VANTA_WINDOWS_RESOURCE_ID;

  const readOne = async (resourceType, resourceId) => {
    if (!resourceId) {
      return { error: `VANTA_${resourceType === 'MacosUserComputer' ? 'MACOS' : 'WINDOWS'}_RESOURCE_ID not set in .env` };
    }
    try {
      const data = await buildClient.get(`/v1/resources/${resourceType}?resourceId=${resourceId}`);
      const all = data.resources || [];
      return {
        active: all.filter(r => !r.deletedAt),
        softDeleted: all.filter(r => r.deletedAt)
      };
    } catch (err) {
      return { error: err.message };
    }
  };

  const [macos, windows] = await Promise.all([
    readOne('MacosUserComputer',   macosResourceId),
    readOne('WindowsUserComputer', windowsResourceId)
  ]);
  return { macos, windows };
}

/**
 * Reads the simulated Evidence-X file store. Stand-in for a customer's
 * local compliance-evidence repository (SharePoint, S3, GRC tool export).
 */
function getEvidenceSource() {
  try {
    const { data, lastModified, mutationCount } = loadEvidenceFiles();
    return {
      total: data.length,
      uploaded: data.filter(f => f.lastUpload).length,
      pending: data.filter(f => !f.lastUpload).length,
      totalBytes: data.reduce((sum, f) => sum + (f.size || 0), 0),
      lastModified,
      mutationCount,
      files: data
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Reads Vanta's evidence-request slot catalog via Manage Vanta. Phase 0
 * confirmed /v1/documents is reachable from the Manage Vanta surface with
 * vanta-api.all:read (which the dashboard already holds for Compliance
 * reads) — no need to switch to Build Integrations' new self:read-document
 * scope for this read path. Keeps the 50/min Manage bucket separation
 * vs the 20/min Build bucket where the uploads run.
 *
 * Returns the FULL slot catalog; the renderer filters to the slots the
 * Evidence-X manifest targets and surfaces "show all" as a foldout for
 * tenants with hundreds of slots.
 */
async function getEvidenceSlots() {
  try {
    const all = await manageClient.fetchAllPages('/v1/documents');
    return {
      total: all.length,
      slots: all,
      needsDocument: all.filter(s => s.uploadStatus === 'Needs document').length,
      // Catalog rendering can also surface anything that has docs already;
      // not every uploadStatus value is "Needs document". Capture the
      // distinct values seen so the renderer can show them faithfully
      // without guessing.
      uploadStatusValues: [...new Set(all.map(s => s.uploadStatus))]
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function getDashboardData() {
  const [
    personnelResult,
    complianceResult,
    pushedRiskResult,
    pushedDevicesResult,
    evidenceSlotsResult
  ] = await Promise.allSettled([
    getPushedPersonnel(),
    getComplianceSnapshot(),
    getPushedRiskScenarios(),
    getPushedDevices(),
    getEvidenceSlots()
  ]);

  return {
    generatedAt: new Date().toISOString(),
    source: getSourceData(),
    personnel: personnelResult.status === 'fulfilled'
      ? personnelResult.value
      : { error: personnelResult.reason?.message || 'unknown error' },
    compliance: complianceResult.status === 'fulfilled'
      ? complianceResult.value
      : { error: complianceResult.reason?.message || 'unknown error' },
    riskSource: getRiskSource(),
    riskPushed: pushedRiskResult.status === 'fulfilled'
      ? pushedRiskResult.value
      : { error: pushedRiskResult.reason?.message || 'unknown error' },
    deviceSource: getDeviceSource(),
    devicePushed: pushedDevicesResult.status === 'fulfilled'
      ? pushedDevicesResult.value
      : { error: pushedDevicesResult.reason?.message || 'unknown error' },
    evidenceSource: getEvidenceSource(),
    evidenceSlots: evidenceSlotsResult.status === 'fulfilled'
      ? evidenceSlotsResult.value
      : { error: evidenceSlotsResult.reason?.message || 'unknown error' },
    webhooks: getWebhooksSnapshot()
  };
}

// Webhook state for the Events tab. Synchronous — reads from the in-memory
// ring buffer the receiver writes to. Surfaces secret-configured flag so
// the tab can render an explicit empty state ("webhook secret unconfigured")
// when VANTA_WEBHOOK_SECRET hasn't been set.
function getWebhooksSnapshot() {
  return {
    secretConfigured: !!process.env.VANTA_WEBHOOK_SECRET,
    events: webhookEventStore.getEvents(),
    workflowSink: {
      payloads: mockWorkflowSink.loadPayloads(),
      bufferCap: mockWorkflowSink.MAX_PAYLOADS
    }
  };
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Detect path-traversal patterns in a candidate explorer path.
 *
 * The /api/explorer/send route validates that the user-supplied path starts
 * with `/v1/`, then concatenates it onto the Vanta base URL. The prior
 * code's prefix check is meaningless on its own: `/v1/../foo` passes the
 * startsWith check, and once concatenated to `https://api.vanta.com`,
 * Node's URL resolver (or CloudFront, or any intermediary) collapses it
 * to `https://api.vanta.com/foo`, escaping the `/v1/` namespace.
 *
 * The endpoint is auth-gated, so this is defense-in-depth for the path-
 * prefix promise rather than protection against an external attacker.
 * Rejected patterns:
 *
 *   - literal `..` as a segment (between slashes, at end, or before `?`)
 *   - backslash anywhere (never legitimate in a Vanta API path)
 *   - URL-encoded `..` (caught before any intermediary decodes it)
 */
function explorerPathHasTraversal(path) {
  if (typeof path !== 'string') return true;
  if (/(^|\/)\.\.(\/|$|\?)/.test(path)) return true;
  if (path.includes('\\')) return true;
  if (/%2e%2e/i.test(path)) return true;
  return false;
}

/**
 * Return an HTML-safe href value, or the empty string if the URL is not a
 * plain http(s) absolute URL.
 *
 * `escapeHtml` neutralizes angle brackets and quotes but does NOT validate
 * the URL scheme — a Vanta response containing `javascript:alert(1)` would
 * render as a clickable XSS link in the authenticated dashboard. Unlikely
 * via the trusted upstream, but defense-in-depth: validate the scheme and
 * drop anything that isn't http(s).
 *
 * Whitespace is trimmed before scheme detection because browsers strip
 * leading whitespace in href before parsing the scheme — `" javascript:.."`
 * is still treated as `javascript:` by the parser, so an unguarded check
 * with just startsWith would miss it.
 */
function safeHref(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return escapeHtml(trimmed);
}

function renderRosterRow(emp) {
  const isActive = emp.status === 'active' && !emp.isServiceAccount;
  const isTerminated = emp.status === 'terminated';
  const isService = emp.isServiceAccount;
  let statusBadge, action;
  if (isActive) {
    statusBadge = `<span class="badge badge-active">active</span>`;
    // data-id + dataset.id avoids the "JS string literal inside HTML attribute" trap
    // where escapeHtml protects HTML context but the value is later HTML-decoded
    // back to a raw apostrophe in the JS engine.
    action = `<button class="btn btn-danger btn-sm" data-id="${escapeHtml(emp.id)}" onclick="offboard(this.dataset.id, event)">Offboard</button>`;
  } else if (isTerminated) {
    statusBadge = `<span class="badge badge-terminated">terminated</span>`;
    action = `<span class="row-note">filtered out of next sync</span>`;
  } else if (isService) {
    statusBadge = `<span class="badge badge-service">service</span>`;
    action = `<span class="row-note">filtered out of next sync</span>`;
  } else {
    statusBadge = `<span class="badge">${escapeHtml(emp.status)}</span>`;
    action = '';
  }
  return `
    <tr>
      <td class="mono">${escapeHtml(emp.id)}</td>
      <td>${escapeHtml(emp.firstName + ' ' + emp.lastName)}</td>
      <td class="mono">${escapeHtml(emp.email)}</td>
      <td>${statusBadge}</td>
      <td class="row-action">${action}</td>
    </tr>
  `;
}

function renderSourceCard(source) {
  if (source.error) {
    return `<div class="card-error">${escapeHtml(source.error)}</div>`;
  }
  const rosterRows = (source.roster || []).map(renderRosterRow).join('');
  const mutationsHint = source.mutationCount > 0
    ? `<span class="mutations-hint">${source.mutationCount} session mutation${source.mutationCount === 1 ? '' : 's'} · <a href="#" onclick="resetMutations(); return false;">reset to baseline</a></span>`
    : `<span class="mutations-hint">no session mutations</span>`;
  return `
    <div class="source-stats">
      <div class="source-stat">
        <div class="source-num" id="src-total">${source.total}</div>
        <div class="source-label">total in source</div>
      </div>
      <div class="source-arrow">→</div>
      <div class="source-stat">
        <div class="source-num" id="src-active">${source.activeEmployees}</div>
        <div class="source-label">active employees</div>
      </div>
      <div class="source-stat">
        <div class="source-num muted" id="src-terminated">${source.terminated}</div>
        <div class="source-label">terminated</div>
      </div>
      <div class="source-stat">
        <div class="source-num muted" id="src-svc">${source.serviceAccounts}</div>
        <div class="source-label">service accounts</div>
      </div>
    </div>
    <table class="roster-table">
      <thead>
        <tr>
          <th>id</th>
          <th>name</th>
          <th>email</th>
          <th>status</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="roster-body">${rosterRows}</tbody>
    </table>
    <div class="source-actions">
      <button class="btn btn-secondary" onclick="hire(event)">+ Hire new employee</button>
      <button class="btn btn-primary" onclick="syncNow()" id="sync-btn">↻ Sync Now</button>
      <button class="btn btn-secondary btn-reset-demo" onclick="resetDemoPersonnel(event)" title="Clear personnel records in Vanta (empty PUT) and reset People-X mock to baseline. Use between demos to restore a clean tenant.">↺ Reset demo state</button>
      ${mutationsHint}
    </div>
    <div class="endpoint-hint">GET /mock-peoplex/employees.json · last modified ${escapeHtml(fmtTime(source.lastModified))}</div>
  `;
}

function renderPersonnelCard(personnel) {
  if (personnel.error) {
    return `<div class="card-error">${escapeHtml(personnel.error)}</div>`;
  }
  const { active = [], softDeleted = [] } = personnel;
  if (active.length === 0 && softDeleted.length === 0) {
    return `
      <div class="hero-stat">
        <div class="hero-num" id="hero-personnel">0</div>
        <div class="hero-label">active records</div>
      </div>
      <div class="empty">No records pushed yet. Run <code>npm run sync:personnel</code> to populate.</div>
    `;
  }
  const rows = active.map(r => `
    <tr>
      <td class="mono">${escapeHtml(r.uniqueId)}</td>
      <td>${escapeHtml(r.displayName || r.fullName || '')}</td>
      <td class="mono">${escapeHtml(r.email || '')}</td>
      <td class="muted">${escapeHtml(fmtTime(r.updatedAt))}</td>
    </tr>
  `).join('');
  const deletedNote = softDeleted.length
    ? `<div class="callout callout-info">
         <strong>+ ${softDeleted.length} soft-deleted</strong> — fell out of the last snapshot.
         Audit history retained, deletedAt timestamped.
       </div>`
    : '';
  // Access Review punchline — the four pushed accounts feed Vanta's Access
  // Review module directly via the LlamaLync integration. This is the demo
  // close: "this is the answer to your CISO's hard requirement."
  const accessReviewNote = active.length
    ? `<div class="callout callout-success">
         <strong>✓ Ready for Access Review</strong> — these ${active.length} accounts are scoped into the LlamaLync integration and feed Vanta's Access Review module directly. Toggle individual accounts in/out of scope from the integration's settings.
       </div>`
    : '';
  return `
    <div class="hero-stat">
      <div class="hero-num" id="hero-personnel">${active.length}</div>
      <div class="hero-label">active record${active.length === 1 ? '' : 's'}</div>
    </div>
    <table>
      <thead>
        <tr><th>uniqueId</th><th>name</th><th>email</th><th>last updated</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${accessReviewNote}
    ${deletedNote}
    <div class="endpoint-hint">GET /v1/resources/user_account?resourceId=…</div>
  `;
}

// ─── Risk tab renderers (slices 5.1–5.3) ────────────────────────────────────

function renderRiskSourceRow(risk) {
  const isUntreated = risk.currentMitigations == null;
  const isClosed = risk.status === 'Closed';
  const score = isUntreated
    ? `<span class="score-cell"><span class="mono">L${risk.inherent.likelihood} × I${risk.inherent.impact}</span><span class="pill-untreated">untreated</span></span>`
    : `<span class="mono">L${risk.inherent.likelihood} × I${risk.inherent.impact} → L${risk.residual.likelihood} × I${risk.residual.impact}</span>`;
  const statusBadge = isClosed
    ? `<span class="badge badge-terminated">closed</span>`
    : `<span class="badge badge-active">open</span>`;

  // Row-level actions are gated by source-side state:
  //   - Apply treatment: only when currentMitigations == null (untreated)
  //   - Mark closed: only when status === 'Open'
  // Closed rows show a "no action" note (mirrors Personnel's terminated rows).
  const idAttr = escapeHtml(risk.internalId);
  let actionCell;
  if (isClosed) {
    actionCell = `<span class="row-note">no action available</span>`;
  } else {
    const buttons = [];
    if (isUntreated) {
      buttons.push(`<button class="btn btn-secondary btn-sm" data-id="${idAttr}" onclick="applyTreatment(this.dataset.id, event)" title="Available only on untreated risks (no current mitigations). Promotes the risk to treated state by setting residual scoring in Risk-X. Re-treatment of an already-treated risk is handled by editing the source register directly — next Sync All mirrors the change to Vanta.">Apply treatment</button>`);
    }
    buttons.push(`<button class="btn btn-danger btn-sm" data-id="${idAttr}" onclick="closeRisk(this.dataset.id, event)" title="Closes the risk in Risk-X (source-side). Next Sync All mirrors status to the Source Status customField in Vanta.">Mark closed</button>`);
    actionCell = `<div class="row-actions">${buttons.join('')}</div>`;
  }

  return `
    <tr>
      <td class="mono">${idAttr}</td>
      <td>${escapeHtml(risk.title)}</td>
      <td>${escapeHtml(risk.category)}</td>
      <td>${escapeHtml(risk.treatment)}</td>
      <td>${score}</td>
      <td>${statusBadge}</td>
      <td class="row-action">${actionCell}</td>
    </tr>
  `;
}

function renderRiskSourceCard(riskSource) {
  if (riskSource.error) {
    return `<div class="card-error">${escapeHtml(riskSource.error)}</div>`;
  }
  if (!riskSource.risks || riskSource.risks.length === 0) {
    return `<div class="empty">Risk-X has no risks defined. Check <code>mock-data/risks.json</code>.</div>`;
  }
  const rows = riskSource.risks.map(renderRiskSourceRow).join('');
  const overdueClass = riskSource.overdueReview > 0 ? '' : 'muted';
  const mutationsHint = riskSource.mutationCount > 0
    ? `<span class="mutations-hint">${riskSource.mutationCount} session mutation${riskSource.mutationCount === 1 ? '' : 's'} · <a href="#" onclick="resetRiskMutations(); return false;">reset to baseline</a></span>`
    : `<span class="mutations-hint">no session mutations</span>`;
  return `
    <div class="source-stats">
      <div class="source-stat">
        <div class="source-num">${riskSource.total}</div>
        <div class="source-label">in register</div>
      </div>
      <div class="source-stat">
        <div class="source-num">${riskSource.open}</div>
        <div class="source-label">open</div>
      </div>
      <div class="source-stat">
        <div class="source-num muted">${riskSource.closed}</div>
        <div class="source-label">closed</div>
      </div>
      <div class="source-stat">
        <div class="source-num">${riskSource.untreated}</div>
        <div class="source-label">untreated</div>
      </div>
      <div class="source-stat">
        <div class="source-num ${overdueClass}">${riskSource.overdueReview}</div>
        <div class="source-label">review overdue</div>
      </div>
    </div>
    <table class="roster-table">
      <thead>
        <tr>
          <th>id</th>
          <th>title</th>
          <th>category</th>
          <th>treatment</th>
          <th>inherent → residual</th>
          <th>status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="source-actions">
      <button class="btn btn-secondary" onclick="addRisk(event)">+ Add risk</button>
      <button class="btn btn-primary" onclick="syncRiskNow()" id="risk-sync-btn">↻ Sync All</button>
      <button class="btn btn-secondary btn-reset-demo" onclick="resetDemoRisk(event)" title="Reset Risk-X mock to baseline. Vanta-side cleanup is manual: open Vanta UI → Risk Management → Archive on each demo-pushed scenario. The risk API exposes isArchived as read-only, so archive can't be triggered programmatically.">↺ Reset demo state</button>
      ${mutationsHint}
    </div>
    <div class="endpoint-hint">GET /mock-riskx/risks.json · last modified ${escapeHtml(fmtTime(riskSource.lastModified))}</div>
  `;
}

function renderPushedRiskCard(riskPushed) {
  if (riskPushed.error) {
    return `<div class="card-error">${escapeHtml(riskPushed.error)}</div>`;
  }
  if (!riskPushed.risks || riskPushed.risks.length === 0) {
    return `
      <div class="hero-stat">
        <div class="hero-num">0</div>
        <div class="hero-label">risk scenario${riskPushed.total === 1 ? '' : 's'}</div>
      </div>
      <div class="empty">No risk scenarios in Vanta yet. Run <code>npm run sync:risk</code> from the CLI to populate.</div>
    `;
  }
  const rows = riskPushed.risks.map(r => {
    const title = ((r.description || '').split('\n\n')[0] || '(no title)').slice(0, 80);
    const scoring = r.residualLikelihood != null
      ? `<span class="mono">L${r.likelihood} × I${r.impact} → L${r.residualLikelihood} × I${r.residualImpact}</span>`
      : `<span class="mono">L${r.likelihood} × I${r.impact}</span>`;
    let reviewBadge;
    if (r.reviewStatus === 'APPROVED') {
      reviewBadge = `<span class="badge badge-active">approved</span>`;
    } else if (r.reviewStatus === 'DRAFT') {
      reviewBadge = `<span class="badge">draft</span>`;
    } else {
      reviewBadge = `<span class="badge">${escapeHtml((r.reviewStatus || '—').toLowerCase())}</span>`;
    }
    return `
      <tr>
        <td class="mono">${escapeHtml(r.riskId || '—')}</td>
        <td>${escapeHtml(title)}</td>
        <td>${escapeHtml((r.categories || []).join(', ') || '—')}</td>
        <td>${scoring}</td>
        <td class="mono">${escapeHtml(r.owner || '—')}</td>
        <td>${reviewBadge}</td>
      </tr>
    `;
  }).join('');
  return `
    <div class="hero-stat">
      <div class="hero-num">${riskPushed.total}</div>
      <div class="hero-label">risk scenario${riskPushed.total === 1 ? '' : 's'}</div>
    </div>
    <table>
      <thead>
        <tr><th>riskId</th><th>title</th><th>categories</th><th>scoring</th><th>owner</th><th>review</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="endpoint-hint">GET /v1/risk-scenarios</div>
  `;
}

// Severity tier for the heat cell at (L, I). Standard 5-tier mapping:
//   1: low (1–3), 2: med-low (4–6), 3: medium (8–10),
//   4: high (12–16), 5: critical (20–25).
function severityTier(L, I) {
  const score = L * I;
  if (score <= 3) return 1;
  if (score <= 6) return 2;
  if (score <= 10) return 3;
  if (score <= 16) return 4;
  return 5;
}

// SVG coordinate helpers. 5×5 grid: each cell 80px square. Grid starts at
// x=70 to leave room for Y-axis labels; y=20 to leave room for the top title.
// Impact axis is inverted (I=5 at top, I=1 at bottom) per standard risk-
// matrix convention.
function matrixCellCenter(L, I) {
  return { cx: 110 + (L - 1) * 80, cy: 60 + (5 - I) * 80 };
}
function matrixCellOrigin(L, I) {
  return { x: 70 + (L - 1) * 80, y: 20 + (5 - I) * 80 };
}

function renderRiskMatrixCard(riskSource) {
  if (riskSource.error) {
    return `<div class="card-error">${escapeHtml(riskSource.error)}</div>`;
  }
  const openRisks = (riskSource.risks || []).filter(r => r.status === 'Open');
  if (openRisks.length === 0) {
    return `<div class="empty">No open risks to plot.</div>`;
  }

  // Aggregate risks by inherent cell so we can render a single dot per cell
  // with a count badge instead of stacking dots on top of each other.
  const inherentCells = new Map(); // 'L-I' → [risks]
  for (const r of openRisks) {
    const key = `${r.inherent.likelihood}-${r.inherent.impact}`;
    if (!inherentCells.has(key)) inherentCells.set(key, []);
    inherentCells.get(key).push(r);
  }

  // Deduplicate arrows by (fromL, fromI, toL, toI). A treated risk with
  // residual === inherent has nothing to draw — skip. Untreated risks
  // (currentMitigations == null) also skip, by definition.
  const arrowMap = new Map();
  for (const r of openRisks) {
    if (r.currentMitigations == null) continue;
    if (r.inherent.likelihood === r.residual.likelihood &&
        r.inherent.impact === r.residual.impact) continue;
    const k = `${r.inherent.likelihood}-${r.inherent.impact}->${r.residual.likelihood}-${r.residual.impact}`;
    if (!arrowMap.has(k)) {
      arrowMap.set(k, {
        fromL: r.inherent.likelihood, fromI: r.inherent.impact,
        toL: r.residual.likelihood,   toI: r.residual.impact,
        risks: []
      });
    }
    arrowMap.get(k).risks.push(r);
  }

  // Build the SVG layer by layer: heat cells → axis labels → arrows → dots.
  // Order matters — dots must render on top of arrows.

  // 1. Heat cells
  const cellSvg = [];
  for (let L = 1; L <= 5; L++) {
    for (let I = 1; I <= 5; I++) {
      const { x, y } = matrixCellOrigin(L, I);
      const tier = severityTier(L, I);
      cellSvg.push(
        `<rect x="${x}" y="${y}" width="80" height="80" class="matrix-cell matrix-cell-${tier}"/>`
      );
    }
  }

  // 2. Axis labels (likelihood along bottom, impact along left)
  const axisSvg = [];
  axisSvg.push(`<text x="290" y="455" class="matrix-axis-title">Likelihood →</text>`);
  axisSvg.push(`<text x="35" y="220" transform="rotate(-90, 35, 220)" class="matrix-axis-title">Impact →</text>`);
  for (let L = 1; L <= 5; L++) {
    axisSvg.push(`<text x="${110 + (L - 1) * 80}" y="440" class="matrix-axis-label">${L}</text>`);
  }
  for (let I = 1; I <= 5; I++) {
    axisSvg.push(`<text x="60" y="${65 + (5 - I) * 80}" class="matrix-axis-label">${I}</text>`);
  }

  // 3. Arrows from inherent → residual centers, with arrowhead marker
  const arrowSvg = [];
  for (const a of arrowMap.values()) {
    const from = matrixCellCenter(a.fromL, a.fromI);
    const to = matrixCellCenter(a.toL, a.toI);
    // Shorten the line by the dot radius on each end so the arrow doesn't
    // start/end inside the dots.
    const dx = to.cx - from.cx, dy = to.cy - from.cy;
    const len = Math.sqrt(dx * dx + dy * dy);
    const startInset = 12, endInset = 14;
    const x1 = from.cx + (dx / len) * startInset;
    const y1 = from.cy + (dy / len) * startInset;
    const x2 = to.cx - (dx / len) * endInset;
    const y2 = to.cy - (dy / len) * endInset;
    const titleText = a.risks.length === 1
      ? `${a.risks[0].internalId}: ${a.risks[0].title}`
      : `${a.risks.length} risks moving (${a.fromL},${a.fromI}) → (${a.toL},${a.toI})`;
    arrowSvg.push(
      `<g><title>${escapeHtml(titleText)}</title>` +
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="risk-arrow" marker-end="url(#risk-arrow-marker)"/>` +
      `</g>`
    );
  }

  // 4. Residual dots (smaller, hollow) — drawn under inherent dots so a
  // residual landing on the same cell as another inherent doesn't visually
  // dominate. Aggregated by residual cell to avoid clutter.
  const residualCells = new Map();
  for (const r of openRisks) {
    if (r.currentMitigations == null) continue;
    if (r.inherent.likelihood === r.residual.likelihood &&
        r.inherent.impact === r.residual.impact) continue;
    const key = `${r.residual.likelihood}-${r.residual.impact}`;
    if (!residualCells.has(key)) residualCells.set(key, []);
    residualCells.get(key).push(r);
  }
  const residualSvg = [];
  for (const [key, risks] of residualCells) {
    const [L, I] = key.split('-').map(Number);
    const { cx, cy } = matrixCellCenter(L, I);
    const titleText = risks.length === 1
      ? `${risks[0].internalId} (residual): ${risks[0].title}`
      : `${risks.length} risks at residual (${L}, ${I})`;
    residualSvg.push(
      `<g><title>${escapeHtml(titleText)}</title>` +
      `<circle cx="${cx}" cy="${cy}" r="7" class="risk-dot-residual"/>` +
      `</g>`
    );
  }

  // 5. Inherent dots — drawn on top. Count badge shows N when ≥ 2.
  const dotSvg = [];
  for (const [key, risks] of inherentCells) {
    const [L, I] = key.split('-').map(Number);
    const { cx, cy } = matrixCellCenter(L, I);
    const titleText = risks.length === 1
      ? `${risks[0].internalId}: ${risks[0].title}`
      : `${risks.length} risks at inherent (${L}, ${I}):\n` + risks.map(r => `  ${r.internalId}: ${r.title}`).join('\n');
    dotSvg.push(
      `<g><title>${escapeHtml(titleText)}</title>` +
      `<circle cx="${cx}" cy="${cy}" r="11" class="risk-dot-inherent"/>` +
      (risks.length > 1
        ? `<text x="${cx}" y="${cy + 1}" class="risk-count-badge">${risks.length}</text>`
        : '') +
      `</g>`
    );
  }

  return `
    <div class="risk-matrix-wrap">
      <svg viewBox="0 0 540 470" class="risk-matrix-svg" role="img" aria-label="Risk-X 5×5 risk matrix">
        <defs>
          <marker id="risk-arrow-marker" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="#374151" opacity="0.7"/>
          </marker>
        </defs>
        ${cellSvg.join('\n        ')}
        ${axisSvg.join('\n        ')}
        ${arrowSvg.join('\n        ')}
        ${residualSvg.join('\n        ')}
        ${dotSvg.join('\n        ')}
      </svg>
    </div>
    <div class="matrix-legend">
      <span class="matrix-legend-item"><span class="matrix-legend-swatch inherent"></span>inherent position</span>
      <span class="matrix-legend-item"><span class="matrix-legend-swatch residual"></span>residual position (after treatment)</span>
      <span class="matrix-legend-item"><span class="matrix-legend-arrow"></span>treatment effect</span>
    </div>
    <div class="endpoint-hint">${openRisks.length} open risk${openRisks.length === 1 ? '' : 's'} plotted · ${arrowMap.size} unique treatment movement${arrowMap.size === 1 ? '' : 's'} · closed risks hidden (see Source table)</div>
  `;
}

// ─── Devices tab renderers ──────────────────────────────────────────────────

// Legend for the per-device compliance badges shown on each source-card row.
// Wrapped in a <details> disclosure so the dense source card stays scannable
// by default — viewers can decode the chips via tooltip on hover, or click
// the summary to expand the full key. The chips themselves carry the
// per-OS / per-chip semantics; the legend is the "show me the key" toggle.
function renderDeviceComplianceLegend() {
  return `
    <details class="compliance-legend-details" aria-label="Compliance badge legend">
      <summary class="compliance-legend-summary">
        <span class="compliance-legend-chevron">▸</span>
        <span class="compliance-legend-summary-label">Compliance chips key</span>
        <span class="compliance-legend-summary-hint">— FV / BL / SL / MGD / XP · click to expand</span>
      </summary>
      <div class="compliance-legend">
        <span class="compliance-legend-item"><span class="dev-badge dev-badge-ok">FV ✓</span> FileVault <span class="muted">(macOS)</span></span>
        <span class="compliance-legend-item"><span class="dev-badge dev-badge-ok">BL ✓</span> BitLocker <span class="muted">(Windows)</span></span>
        <span class="compliance-legend-item"><span class="dev-badge dev-badge-ok">SL ✓</span> Screen-lock policy</span>
        <span class="compliance-legend-item"><span class="dev-badge dev-badge-ok">MGD ✓</span> Enrolled in MDM</span>
        <span class="compliance-legend-item"><span class="dev-badge dev-badge-ok">XP ✓</span> XProtect <span class="muted">(macOS)</span></span>
        <span class="compliance-legend-tone"><span class="dev-badge dev-badge-ok">✓</span> meets policy</span>
        <span class="compliance-legend-tone"><span class="dev-badge dev-badge-warn">✗</span> warn</span>
        <span class="compliance-legend-tone"><span class="dev-badge dev-badge-bad">✗</span> fail</span>
      </div>
    </details>
  `;
}

// Legend for the Windows Security Center pills. Same disclosure pattern as
// the compliance-chip legend above — collapsed by default, expanded on
// click. Five enum-rated states with brief, scannable descriptions.
function renderWscLegend() {
  return `
    <details class="wsc-legend-details" aria-label="Windows Security Center signal legend">
      <summary class="wsc-legend-summary">
        <span class="wsc-legend-chevron">▸</span>
        <span class="wsc-legend-summary-label">Signal states key</span>
        <span class="wsc-legend-summary-hint">— GOOD / POOR / SNOOZED / NOT_MONITORED / ERROR · click to expand</span>
      </summary>
      <div class="wsc-legend">
        <span class="wsc-legend-item"><span class="wsc-pill wsc-good">GOOD</span> healthy</span>
        <span class="wsc-legend-item"><span class="wsc-pill wsc-poor">POOR</span> misconfigured</span>
        <span class="wsc-legend-item"><span class="wsc-pill wsc-snoozed">SNOOZED</span> alerts dismissed</span>
        <span class="wsc-legend-item"><span class="wsc-pill wsc-notmonitored">NOT_MONITORED</span> no signal</span>
        <span class="wsc-legend-item"><span class="wsc-pill wsc-error">ERROR</span> service unhealthy</span>
      </div>
    </details>
  `;
}

// Inline SVG logos for the OS pill on each Devices source-card row. Paths
// copied from Simple Icons (simpleicons.org, MIT-licensed). Monochrome —
// `fill: currentColor` lets each pill's text color drive the logo color so
// the existing platform-tinted pills stay visually consistent. Tooltips
// remain on the wrapping pill via the title attribute, so hover-reveal of
// the full platform name still works without any text content in the pill.
function renderOsIcon(os) {
  if (os === 'macOS') {
    return `<svg class="os-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`;
  }
  if (os === 'Windows') {
    return `<svg class="os-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M0,0H11.377V11.372H0ZM12.623,0H24V11.372H12.623ZM0,12.623H11.377V24H0Zm12.623,0H24V24H12.623"/></svg>`;
  }
  if (os === 'Linux') {
    return `<svg class="os-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z"/></svg>`;
  }
  return '';
}

// Compliance badge cluster shown for a device row. Per-OS variation:
//   - macOS:   FileVault, screenlock, antivirus (XProtect), managed
//   - Windows: BitLocker (drive.encrypted), screenlock, defender via WSC, managed
//   - Linux:   surfaced separately as "unsupported source row" — no badges
function renderDeviceBadges(device) {
  if (device.os === 'Linux') return '';
  const badges = [];
  const drives = device.drives || [];
  const drive = drives[0] || {};
  const screenlockOn = !!(device.systemScreenlockPolicies || []).some(p => p.requiresPassword)
    || !!(device.users || []).some(u => u.screenlockSettings && u.screenlockSettings.requiresPassword);

  if (device.os === 'macOS') {
    badges.push(drive.filevaultEnabled
      ? `<span class="dev-badge dev-badge-ok" title="FileVault enabled on boot volume">FV ✓</span>`
      : `<span class="dev-badge dev-badge-bad" title="FileVault DISABLED — disk-encryption compliance gap">FV ✗</span>`);
    badges.push(device.isXProtectEnabled
      ? `<span class="dev-badge dev-badge-ok" title="macOS XProtect malware protection on">XP ✓</span>`
      : `<span class="dev-badge dev-badge-warn" title="XProtect disabled — endpoint malware protection gap">XP ✗</span>`);
  } else {
    badges.push(drive.encrypted
      ? `<span class="dev-badge dev-badge-ok" title="BitLocker (or equivalent) on boot volume">BL ✓</span>`
      : `<span class="dev-badge dev-badge-bad" title="Boot volume NOT encrypted — disk-encryption compliance gap">BL ✗</span>`);
  }
  badges.push(screenlockOn
    ? `<span class="dev-badge dev-badge-ok" title="Screen-lock policy requires password">SL ✓</span>`
    : `<span class="dev-badge dev-badge-warn" title="No screen-lock policy enforced">SL ✗</span>`);
  badges.push(device.isManaged
    ? `<span class="dev-badge dev-badge-ok" title="Enrolled in MDM / managed">MGD ✓</span>`
    : `<span class="dev-badge dev-badge-warn" title="Not managed by MDM — manual evidence required">MGD ✗</span>`);
  return badges.join(' ');
}

function renderDeviceSourceRow(device, emailById) {
  const ownerEmail = device.assignedEmployeeId ? (emailById.get(device.assignedEmployeeId) || null) : null;
  const isDecom = device.status === 'decommissioned';
  const isLinux = device.os === 'Linux';
  // OS pill = brand-tinted background + Simple Icons logo (Apple / Windows /
  // Tux). Tooltip carries the full platform name on hover; the warning glyph
  // stays on the Linux pill since "unsupported native resource type" is a
  // separate concept from "this is a Linux device" and viewers should see
  // both at a glance.
  const osBadge = device.os === 'macOS'   ? `<span class="badge badge-os badge-os-macos"   title="macOS — MacosUserComputer">${renderOsIcon('macOS')}</span>`
                : device.os === 'Windows' ? `<span class="badge badge-os badge-os-windows" title="Windows — WindowsUserComputer">${renderOsIcon('Windows')}</span>`
                                          : `<span class="badge badge-os badge-os-linux"   title="Linux — no native Vanta resource type; surfaced as unsupported source row">${renderOsIcon('Linux')}<span class="badge-os-warn">⚠</span></span>`;
  const statusBadge = isDecom
    ? `<span class="badge badge-terminated">decommissioned</span>`
    : isLinux
      ? `<span class="badge badge-warn" title="No native Vanta computer resource type for Linux; this row is excluded from any PUT but visible here for compliance-gap transparency">unsupported</span>`
      : `<span class="badge badge-active">active</span>`;
  const ownerCell = ownerEmail
    ? `<span class="mono">${escapeHtml(ownerEmail)}</span>`
    : `<span class="row-note" title="No assignedEmployeeId in CMDB-X — orphan device, ownerless compliance gap">(orphan)</span>`;

  const idAttr = escapeHtml(device.id);
  let actionCell;
  if (isDecom) {
    actionCell = `<span class="row-note">no action available</span>`;
  } else {
    const buttons = [];
    buttons.push(`<button class="btn btn-secondary btn-sm" data-id="${idAttr}" onclick="reassignOwner(this.dataset.id, event)" title="Reassign this device to a different (or null) employee in CMDB-X. Next Sync All pushes the owner change to Vanta.">Reassign</button>`);
    if (!isLinux) {
      buttons.push(`<button class="btn btn-danger btn-sm" data-id="${idAttr}" onclick="decommissionDevice(this.dataset.id, event)" title="Mark this device decommissioned in CMDB-X (source-side). Next Sync All drops it from the platform PUT; Vanta soft-deletes via full-snapshot semantics.">Decommission</button>`);
    }
    actionCell = `<div class="row-actions">${buttons.join('')}</div>`;
  }

  return `
    <tr>
      <td class="mono">${idAttr}</td>
      <td>${escapeHtml(device.hostname)}</td>
      <td>${osBadge}</td>
      <td>${ownerCell}</td>
      <td>${renderDeviceBadges(device)}</td>
      <td>${statusBadge}</td>
      <td class="row-action">${actionCell}</td>
    </tr>
  `;
}

function renderDeviceSourceCard(deviceSource, emailById) {
  if (deviceSource.error) {
    return `<div class="card-error">${escapeHtml(deviceSource.error)}</div>`;
  }
  if (!deviceSource.devices || deviceSource.devices.length === 0) {
    return `<div class="empty">CMDB-X has no devices defined. Check <code>mock-data/devices.json</code>.</div>`;
  }
  // Show active devices first, then decommissioned grouped at the bottom.
  const sortedDevices = [...deviceSource.devices].sort((a, b) => {
    const aActive = a.status !== 'decommissioned';
    const bActive = b.status !== 'decommissioned';
    if (aActive !== bActive) return aActive ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  const rows = sortedDevices.map(d => renderDeviceSourceRow(d, emailById)).join('');
  const orphanClass     = deviceSource.orphans     > 0 ? '' : 'muted';
  const unencryptedClass = deviceSource.unencrypted > 0 ? '' : 'muted';
  const unmanagedClass  = deviceSource.unmanaged   > 0 ? '' : 'muted';
  const linuxClass      = deviceSource.linux       > 0 ? '' : 'muted';
  const staleClass      = deviceSource.staleCheckIn30d > 0 ? '' : 'muted';
  const mutationsHint = deviceSource.mutationCount > 0
    ? `<span class="mutations-hint">${deviceSource.mutationCount} session mutation${deviceSource.mutationCount === 1 ? '' : 's'} · <a href="#" onclick="resetCmdbMutations(); return false;">reset to baseline</a></span>`
    : `<span class="mutations-hint">no session mutations</span>`;
  return `
    <div class="source-stats source-stats-grouped">
      <div class="source-stats-group" aria-label="Inventory">
        <div class="source-stat">
          <div class="source-num">${deviceSource.active}</div>
          <div class="source-label">active</div>
        </div>
        <div class="source-stat">
          <div class="source-num">${deviceSource.macos}</div>
          <div class="source-label">macOS</div>
        </div>
        <div class="source-stat">
          <div class="source-num">${deviceSource.windows}</div>
          <div class="source-label">Windows</div>
        </div>
        <div class="source-stat">
          <div class="source-num ${linuxClass}" title="Linux has no native Vanta computer resource type — these are excluded from PUTs and surfaced separately for compliance transparency">${deviceSource.linux}</div>
          <div class="source-label">Linux ⚠</div>
        </div>
      </div>
      <div class="source-stats-divider" aria-hidden="true"></div>
      <div class="source-stats-group" aria-label="Compliance gaps">
        <div class="source-stat">
          <div class="source-num ${orphanClass}">${deviceSource.orphans}</div>
          <div class="source-label">orphan</div>
        </div>
        <div class="source-stat">
          <div class="source-num ${unencryptedClass}">${deviceSource.unencrypted}</div>
          <div class="source-label">unencrypted</div>
        </div>
        <div class="source-stat">
          <div class="source-num ${unmanagedClass}">${deviceSource.unmanaged}</div>
          <div class="source-label">unmanaged</div>
        </div>
        <div class="source-stat">
          <div class="source-num ${staleClass}">${deviceSource.staleCheckIn30d}</div>
          <div class="source-label">stale &gt;30d</div>
        </div>
      </div>
    </div>
    ${renderDeviceComplianceLegend()}
    <table class="roster-table">
      <thead>
        <tr>
          <th>id</th>
          <th>hostname</th>
          <th>OS</th>
          <th>owner</th>
          <th>compliance</th>
          <th>status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="source-actions">
      <button class="btn btn-secondary" onclick="onboardDevice(event)">+ Onboard device</button>
      <button class="btn btn-primary" onclick="syncDevicesNow()" id="device-sync-btn">↻ Sync All</button>
      <button class="btn btn-secondary btn-reset-demo" onclick="resetDemoDevices(event)" title="Clear MacosUserComputer + WindowsUserComputer records in Vanta (empty PUTs) and reset CMDB-X mock to baseline. Use between demos to restore a clean tenant.">↺ Reset demo state</button>
      ${mutationsHint}
    </div>
    <div class="endpoint-hint">GET /mock-cmdbx/devices.json · last modified ${escapeHtml(fmtTime(deviceSource.lastModified))}</div>
  `;
}

function renderPushedDevicesCard(devicePushed) {
  if (devicePushed.error) {
    return `<div class="card-error">${escapeHtml(devicePushed.error)}</div>`;
  }
  const renderPlatformRows = (platform, payload, resourceType) => {
    if (!payload) return '';
    if (payload.error) {
      return `
        <div class="pushed-platform">
          <h4>${platform}</h4>
          <div class="card-error">${escapeHtml(payload.error)}</div>
        </div>
      `;
    }
    const active = payload.active || [];
    if (active.length === 0) {
      return `
        <div class="pushed-platform">
          <h4>${platform}</h4>
          <div class="empty">No ${platform} records in Vanta. Run <code>npm run sync:devices</code> to populate.</div>
        </div>
      `;
    }
    const rows = active.map(r => {
      const owner = r.owner
        ? `<span class="mono">${escapeHtml(r.owner)}</span>`
        : `<span class="row-note">(no owner)</span>`;
      return `
        <tr>
          <td class="mono">${escapeHtml(r.uniqueId || '—')}</td>
          <td>${escapeHtml(r.displayName || '—')}</td>
          <td><span class="mono">${escapeHtml(r.osVersion || '—')}</span></td>
          <td>${owner}</td>
        </tr>
      `;
    }).join('');
    return `
      <div class="pushed-platform">
        <h4>${platform} <span class="pushed-platform-count">${active.length}</span></h4>
        <table>
          <thead><tr><th>uniqueId</th><th>displayName</th><th>osVersion</th><th>owner</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="endpoint-hint">GET /v1/resources/${resourceType}</div>
      </div>
    `;
  };

  const macosTotal = devicePushed.macos && !devicePushed.macos.error
    ? (devicePushed.macos.active || []).length : 0;
  const windowsTotal = devicePushed.windows && !devicePushed.windows.error
    ? (devicePushed.windows.active || []).length : 0;

  return `
    <div class="hero-stat">
      <div class="hero-num">${macosTotal + windowsTotal}</div>
      <div class="hero-label">computer${macosTotal + windowsTotal === 1 ? '' : 's'} across both platforms</div>
    </div>
    <div class="pushed-platforms">
      ${renderPlatformRows('macOS',   devicePushed.macos,   'MacosUserComputer')}
      ${renderPlatformRows('Windows', devicePushed.windows, 'WindowsUserComputer')}
    </div>
  `;
}

// Windows Security Center signals are the materially richer Windows-only
// piece of the JTD schema (six independent enum-rated signals plus per-product
// state). This card surfaces them prominently because Windows posture data
// is one of the strongest visible signals in this scenario, and only Windows
// offers this granularity natively in Vanta's schema.
function renderWindowsSecurityCenterCard(deviceSource) {
  if (deviceSource.error) {
    return `<div class="card-error">${escapeHtml(deviceSource.error)}</div>`;
  }
  const wins = (deviceSource.devices || [])
    .filter(d => d.os === 'Windows' && d.status !== 'decommissioned');
  if (wins.length === 0) {
    return `<div class="empty">No active Windows devices in CMDB-X to evaluate.</div>`;
  }
  const wscClass = (v) => {
    if (v === 'GOOD')           return 'wsc-good';
    if (v === 'POOR')           return 'wsc-poor';
    if (v === 'SNOOZED')        return 'wsc-snoozed';
    if (v === 'NOT_MONITORED')  return 'wsc-notmonitored';
    if (v === 'ERROR')          return 'wsc-error';
    return 'wsc-unknown';
  };
  const signals = [
    { key: 'firewall',                     label: 'Firewall' },
    { key: 'antivirus',                    label: 'Antivirus' },
    { key: 'autoupdate',                   label: 'AutoUpdate' },
    { key: 'internetSetting',              label: 'IE Settings' },
    { key: 'userAccountControl',           label: 'UAC' },
    { key: 'windowsSecurityCenterService', label: 'WSC Service' }
  ];
  const rows = wins.map(d => {
    const wsc = d.windowsSecurityCenter || {};
    const cells = signals.map(s => {
      const v = wsc[s.key];
      const cls = wscClass(v);
      return `<td><span class="wsc-pill ${cls}" title="${escapeHtml(s.label)}: ${escapeHtml(v || 'unknown')}">${escapeHtml(v || '—')}</span></td>`;
    }).join('');
    return `
      <tr>
        <td class="mono">${escapeHtml(d.id)}</td>
        <td>${escapeHtml(d.hostname)}</td>
        ${cells}
      </tr>
    `;
  }).join('');
  return `
    ${renderWscLegend()}
    <table class="wsc-table">
      <thead>
        <tr>
          <th>id</th>
          <th>hostname</th>
          ${signals.map(s => `<th>${escapeHtml(s.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="endpoint-hint">${wins.length} Windows device${wins.length === 1 ? '' : 's'} · six enum-rated signals per device · Windows-only schema field <code>windowsSecurityCenter</code></div>
  `;
}

// Linux source rows surfaced as the "unsupported source row" panel —
// strongest SA demo moment per the GAP 1 plan amendment. These devices
// are NOT pushed to Vanta (no native LinuxUserComputer resource type
// exists in Vanta's catalog as of 2026-05-13).
function renderUnsupportedLinuxCard(deviceSource, emailById) {
  if (deviceSource.error) {
    return `<div class="card-error">${escapeHtml(deviceSource.error)}</div>`;
  }
  const linux = (deviceSource.devices || [])
    .filter(d => d.os === 'Linux' && d.status !== 'decommissioned');
  if (linux.length === 0) {
    return `<div class="empty muted">No Linux devices in CMDB-X. (When present, they would appear here as unsupported source rows — excluded from Vanta PUTs but visible for compliance-gap transparency.)</div>`;
  }
  const rows = linux.map(d => {
    const ownerEmail = d.assignedEmployeeId ? (emailById.get(d.assignedEmployeeId) || null) : null;
    const ownerCell = ownerEmail
      ? `<span class="mono">${escapeHtml(ownerEmail)}</span>`
      : `<span class="row-note">(orphan)</span>`;
    return `
      <tr>
        <td class="mono">${escapeHtml(d.id)}</td>
        <td>${escapeHtml(d.hostname)}</td>
        <td><span class="mono">${escapeHtml(d.osVersion)}</span></td>
        <td>${ownerCell}</td>
        <td class="mono">${escapeHtml(fmtTime(d.lastSeen))}</td>
      </tr>
    `;
  }).join('');
  return `
    <div class="callout callout-warn callout-inline">
      <strong>${linux.length} Linux device${linux.length === 1 ? '' : 's'} cannot push natively.</strong>
      Vanta has no <code>LinuxUserComputer</code> base resource type as of 2026-05-13. These rows are
      <strong>deliberately surfaced</strong> rather than silently dropped — auditors see exactly which
      fleet members fall outside native coverage. Compensating evidence belongs in a separate audit
      record. See <code>docs/scenarios/devices.md §5</code> for the Go/No-Go rationale.
    </div>
    <table class="roster-table">
      <thead>
        <tr><th>id</th><th>hostname</th><th>osVersion</th><th>owner</th><th>lastSeen</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="endpoint-hint">Not pushed · source-side only · <code>sync.skipped.linuxUnsupported = ${linux.length}</code></div>
  `;
}

// ─── Evidence tab renderers ────────────────────────────────────────────────

// Per-file row in the Evidence-X source table. Shows filename, size,
// MIME, target slot, and a per-row Upload button. After upload, the
// session-history badge replaces the button (✓ uploaded · view in Vanta).
function renderEvidenceSourceRow(file) {
  const filenameAttr = escapeHtml(file.filename);
  const sizeKb = Math.round((file.size || 0) / 102.4) / 10; // 1 decimal place
  const mimeBadge = `<span class="badge mime-badge" title="${escapeHtml(file.mimeType)}">${escapeHtml(file.mimeType.split('/')[1] || file.mimeType)}</span>`;

  let actionCell;
  if (file.lastUpload) {
    // Already uploaded this session — show the badge + a "view" link to the
    // Vanta-side URL the upload response handed back. Lets the operator jump
    // from the dashboard into the actual record in Vanta UI in a new tab.
    const uploadedAt = escapeHtml(fmtTime(file.lastUpload.uploadedAt));
    // safeHref drops non-http(s) schemes — if Vanta ever returned a
    // `javascript:` or `data:` URL it's omitted rather than rendered as a
    // clickable XSS link in the authenticated dashboard.
    const safeVantaUrl = safeHref(file.lastUpload.vantaUrl);
    const vantaUrl = safeVantaUrl
      ? `<a href="${safeVantaUrl}" target="_blank" rel="noopener noreferrer" class="evidence-view-link">view in Vanta ↗</a>`
      : '';
    actionCell = `
      <div class="row-actions evidence-uploaded">
        <span class="evidence-uploaded-badge" title="Uploaded this session at ${uploadedAt}">✓ uploaded</span>
        ${vantaUrl}
      </div>
    `;
  } else {
    actionCell = `<div class="row-actions"><button class="btn btn-primary btn-sm" data-filename="${filenameAttr}" onclick="uploadEvidence(this.dataset.filename, event)" title="POST multipart upload to /v1/documents/${escapeHtml(file.targetSlot)}/uploads via the Build Integrations app with self:write-document scope">Upload to Vanta</button></div>`;
  }

  return `
    <tr>
      <td class="mono">${filenameAttr}</td>
      <td>${mimeBadge}</td>
      <td class="mono">${sizeKb} KB</td>
      <td><span class="evidence-slot-pill" title="Vanta evidence-request slot — see the Vanta-side card for the slot's auditor-facing description">${escapeHtml(file.targetSlot)}</span></td>
      <td class="row-action">${actionCell}</td>
    </tr>
  `;
}

function renderEvidenceSourceCard(evidenceSource) {
  if (evidenceSource.error) {
    return `<div class="card-error">${escapeHtml(evidenceSource.error)}</div>`;
  }
  if (!evidenceSource.files || evidenceSource.files.length === 0) {
    return `<div class="empty">Evidence-X has no files defined. Check <code>mock-data/evidence/_manifest.json</code>.</div>`;
  }
  const rows = evidenceSource.files.map(renderEvidenceSourceRow).join('');
  const totalKb = Math.round((evidenceSource.totalBytes || 0) / 102.4) / 10;
  const uploadedClass = evidenceSource.uploaded > 0 ? '' : 'muted';
  const pendingClass  = evidenceSource.pending  > 0 ? '' : 'muted';
  const mutationsHint = evidenceSource.mutationCount > 0
    ? `<span class="mutations-hint">${evidenceSource.mutationCount} session upload${evidenceSource.mutationCount === 1 ? '' : 's'} · <a href="#" onclick="resetEvidenceMutations(); return false;">reset session</a></span>`
    : `<span class="mutations-hint">no uploads this session</span>`;
  return `
    <div class="source-stats">
      <div class="source-stat">
        <div class="source-num">${evidenceSource.total}</div>
        <div class="source-label">files in manifest</div>
      </div>
      <div class="source-stat">
        <div class="source-num ${uploadedClass}">${evidenceSource.uploaded}</div>
        <div class="source-label">uploaded</div>
      </div>
      <div class="source-stat">
        <div class="source-num ${pendingClass}">${evidenceSource.pending}</div>
        <div class="source-label">pending</div>
      </div>
      <div class="source-stat">
        <div class="source-num">${totalKb}</div>
        <div class="source-label">KB total</div>
      </div>
    </div>
    <table class="roster-table">
      <thead>
        <tr>
          <th>filename</th>
          <th>type</th>
          <th>size</th>
          <th>target slot</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="source-actions">
      <button class="btn btn-secondary btn-reset-demo" onclick="resetDemoEvidence(event)" title="Clear in-session upload history. Vanta-side cleanup of uploaded evidence files requires manual action — slot-bound documents have no DELETE endpoint.">↺ Reset demo state</button>
      ${mutationsHint}
    </div>
    <div class="endpoint-hint">GET /mock-evidencex/files.json · last modified ${escapeHtml(fmtTime(evidenceSource.lastModified))}</div>
  `;
}

function renderEvidenceSlotsCard(evidenceSource, evidenceSlots) {
  if (evidenceSlots.error) {
    return `<div class="card-error">${escapeHtml(evidenceSlots.error)}</div>`;
  }
  if (!evidenceSlots.slots || evidenceSlots.slots.length === 0) {
    return `
      <div class="hero-stat">
        <div class="hero-num">0</div>
        <div class="hero-label">slots in tenant</div>
      </div>
      <div class="empty">No evidence-request slots returned from Vanta. Verify <code>vanta-api.all:read</code> on the Manage Vanta app.</div>
    `;
  }
  // Slot ids the mock manifest targets — those are the slots we render
  // prominently. Other slots remain in the tenant catalog but are folded
  // away by default since a real customer tenant has 50+ slots and most
  // are irrelevant to the demo.
  const targetedSlotIds = new Set((evidenceSource?.files || []).map(f => f.targetSlot));
  const targetedSlots = evidenceSlots.slots.filter(s => targetedSlotIds.has(s.id));
  const otherSlots = evidenceSlots.slots.filter(s => !targetedSlotIds.has(s.id));

  // Build a slotId → most-recent session upload map. This is LlamaLync's own
  // observation of what landed where — distinct from Vanta's `uploadStatus`,
  // which lags the actual upload (Vanta's compliance engine waits on its own
  // gating). The dashboard surfaces this on each slot row so the integration
  // can show the upload succeeded even when the Vanta-side status hasn't
  // caught up.
  const sessionUploadsBySlot = new Map();
  for (const file of (evidenceSource?.files || [])) {
    if (!file.lastUpload || !file.lastUpload.slotId) continue;
    const prior = sessionUploadsBySlot.get(file.lastUpload.slotId);
    if (!prior || file.lastUpload.uploadedAt > prior.uploadedAt) {
      sessionUploadsBySlot.set(file.lastUpload.slotId, {
        uploadedAt: file.lastUpload.uploadedAt,
        filename:   file.filename,
        vantaUrl:   file.lastUpload.vantaUrl
      });
    }
  }

  const slotRow = (slot) => {
    const status = slot.uploadStatus || 'Needs document';
    const statusClass = status === 'Needs document' ? 'badge-warn' : 'badge-active';
    const safeSlotUrl = safeHref(slot.url);
    const url = safeSlotUrl
      ? `<a href="${safeSlotUrl}" target="_blank" rel="noopener noreferrer" class="evidence-view-link">view ↗</a>`
      : '';
    const description = (slot.description || '').split('\n')[0].slice(0, 140);
    const truncated = (slot.description || '').length > 140 ? '…' : '';

    // Render the session-upload marker when LlamaLync uploaded anything to
    // this slot during the current session. Honest framing: "we observed
    // this upload landing — Vanta's status may lag." Document icon + the
    // file's own name so an SE pointing at the row says "this file landed
    // here at this time" not "something landed somewhere."
    const sessionUpload = sessionUploadsBySlot.get(slot.id);
    let sessionMarker = '';
    if (sessionUpload) {
      const timeOnly = (sessionUpload.uploadedAt || '').slice(11, 19) + ' UTC';
      // Feather "file-text" SVG — same visual style as the signout / OS
      // icons elsewhere so the marker rhymes with the rest of the UI rather
      // than looking like a misplaced emoji.
      const fileIcon = '<svg class="evidence-session-marker-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>';
      sessionMarker = `<span class="evidence-session-marker" title="LlamaLync uploaded ${escapeHtml(sessionUpload.filename)} to this slot at ${escapeHtml(fmtTime(sessionUpload.uploadedAt))}. The file is in Vanta's revision history (clickable link in the rightmost column) — Vanta's slot-summary status may lag behind the upload until the compliance engine processes it.">${fileIcon}<span class="evidence-session-marker-name">${escapeHtml(sessionUpload.filename)}</span> @ ${escapeHtml(timeOnly)}</span>`;
    }

    return `
      <tr>
        <td class="mono">${escapeHtml(slot.id)}</td>
        <td>${escapeHtml(slot.title || '—')}</td>
        <td><span class="badge ${statusClass}">${escapeHtml(status)}</span>${sessionMarker}</td>
        <td class="evidence-slot-desc">${escapeHtml(description)}${truncated}</td>
        <td class="row-action">${url}</td>
      </tr>
    `;
  };

  const targetedRows = targetedSlots.map(slotRow).join('');
  const targetedSection = targetedSlots.length > 0
    ? `
      <h4 class="evidence-slot-subheader">Slots the Evidence-X manifest targets <span class="evidence-slot-subcount">${targetedSlots.length} of ${evidenceSlots.total} in tenant</span></h4>
      <table class="evidence-slots-table">
        <thead>
          <tr><th>slot id</th><th>title</th><th>status</th><th>description (excerpt)</th><th></th></tr>
        </thead>
        <tbody>${targetedRows}</tbody>
      </table>
    `
    : `<div class="empty">No targeted slot ids matched any Vanta slot. Check the manifest's <code>targetSlot</code> values against your tenant's catalog.</div>`;

  // The full tenant catalog goes behind a details disclosure — it's
  // discoverable but doesn't dominate the card. Renders the same row
  // shape for visual consistency.
  const otherRows = otherSlots.slice(0, 100).map(slotRow).join(''); // cap at 100 to keep DOM size reasonable
  const fullCatalogSection = otherSlots.length > 0
    ? `
      <details class="evidence-full-catalog">
        <summary>
          <span class="evidence-full-catalog-chevron">▸</span>
          Show full tenant slot catalog <span class="muted">(${otherSlots.length} more — uploadStatus distribution: ${escapeHtml(evidenceSlots.uploadStatusValues.join(' / '))})</span>
        </summary>
        <table class="evidence-slots-table evidence-slots-other">
          <thead><tr><th>slot id</th><th>title</th><th>status</th><th>description (excerpt)</th><th></th></tr></thead>
          <tbody>${otherRows}</tbody>
        </table>
      </details>
    `
    : '';

  return `
    <div class="hero-stat">
      <div class="hero-num">${evidenceSlots.total}</div>
      <div class="hero-label">evidence-request slot${evidenceSlots.total === 1 ? '' : 's'} in tenant · ${evidenceSlots.needsDocument} flagged "Needs document"</div>
    </div>
    ${targetedSection}
    ${fullCatalogSection}
    <div class="endpoint-hint">GET /v1/documents · paginated · Manage Vanta read scope</div>
  `;
}

// ─── Events / Webhooks tab ────────────────────────────────────────────────
//
// Read-only view of the Vanta-webhook receiver pipeline. Shape inverts the
// other scenario tabs: instead of LlamaLync pulling from a mock source and
// pushing to Vanta, here Vanta pushes to LlamaLync and we record what
// arrives + how it was processed. The forward column shows the in-process
// hand-off to the Workflow Sink destination.

// Processing status -> badge class. Status is the rightmost column on the
// Events row; rendering it as a badge keeps the row visually consistent
// with verify / dedupe / forward columns instead of dropping to plain mono.
const PROCESSING_STATUS_BADGE = {
  forwarded:        'badge-good',
  deduped:          'badge-muted',
  rejected:         'badge-bad',
  'forward-failed': 'badge-bad'
};

// vantaObject.type -> family badge class. Color is categorical wayfinding
// (which entity), NOT priority. Unknown entities fall through to muted so
// they're visibly distinct without claiming a hue they didn't earn.
const FAMILY_BADGE_CLASS = {
  questionnaire:  'badge-family-questionnaire',
  accessRequest:  'badge-family-access-request',
  vendorDecision: 'badge-family-vendor-decision'
};

function renderWebhookEventRow(event) {
  const v = event.verification || {};
  const dedupeStatus = event.dedupe?.status || 'unknown';
  const verifyBadge = v.ok
    ? '<span class="badge badge-good">verified</span>'
    : `<span class="badge badge-bad" title="${escapeHtml(v.error || '')}">rejected</span>`;
  const dedupeBadge = dedupeStatus === 'duplicate'
    ? '<span class="badge badge-warn" title="Same svix-id arrived twice. At-least-once delivery is expected; Vanta retried and we returned 200 without re-processing.">duplicate</span>'
    : dedupeStatus === 'fresh'
      ? '<span class="badge badge-good">fresh</span>'
      : `<span class="badge badge-muted">${escapeHtml(dedupeStatus)}</span>`;

  // Forward badge — tooltip carries the generated Workflow Sink payload
  // summary so an SE can confirm the right payload got created without
  // opening detail. Empty/missing forward block means recorded but not
  // forwarded (rejected signature path).
  const fwd = event.forward;
  let forwardBadge;
  if (!fwd) {
    forwardBadge = '<span class="badge badge-muted" title="No forward attempted — rejected signature or pre-forward entry.">—</span>';
  } else if (fwd.ok) {
    forwardBadge = `<span class="badge badge-good" title="Workflow Sink payload: ${escapeHtml(fwd.summary || fwd.payloadId || '')}">forwarded</span>`;
  } else {
    forwardBadge = `<span class="badge badge-bad" title="${escapeHtml(fwd.error || 'forward failed')}">failed</span>`;
  }

  const status = event.processingStatus || '—';
  const statusClass = PROCESSING_STATUS_BADGE[status] || 'badge-muted';
  const svixId = event.svixId || '—';

  return `
    <tr>
      <td class="mono">${escapeHtml(fmtTime(event.receivedAt))}</td>
      <td class="mono">${escapeHtml(event.eventType || '—')}</td>
      <td class="mono"><span class="webhook-svix-id" title="${escapeHtml(svixId)} — svix-id (delivery dedupe key)">${escapeHtml(svixId)}</span></td>
      <td>${verifyBadge}</td>
      <td>${dedupeBadge}</td>
      <td>${forwardBadge}</td>
      <td><span class="badge ${statusClass}">${escapeHtml(status)}</span></td>
    </tr>
  `;
}

function renderWorkflowSinkRow(p) {
  // Family badge — vantaObject.type. Color is categorical (which entity),
  // never priority; severity stays out of the payload by design.
  const family = (p.vantaObject && p.vantaObject.type) || 'unknown';
  const familyClass = FAMILY_BADGE_CLASS[family] || 'badge-muted';
  const obj = p.vantaObject || {};
  const objStr = obj.id ? `${escapeHtml(obj.type || '?')} · ${escapeHtml(obj.id)}` : escapeHtml(obj.type || '—');
  return `
    <tr>
      <td class="mono">${escapeHtml(fmtTime(p.receivedAt))}</td>
      <td class="mono">${escapeHtml(p.id || '—')}</td>
      <td><span class="badge ${familyClass}">${escapeHtml(family)}</span></td>
      <td>${escapeHtml(p.summary || '—')}</td>
      <td class="mono">${escapeHtml(p.vantaEvent || '—')}</td>
      <td class="mono">${objStr}</td>
    </tr>
  `;
}

function renderWorkflowSinkCard(workflowSink) {
  const payloads = (workflowSink && workflowSink.payloads) || [];
  const bufferCap = workflowSink.bufferCap || 50;

  // Per-family counts mirror the Events hero stat shape. Order is the
  // canonical (questionnaire / access request / vendor decision) sequence
  // used elsewhere; unknown only renders when something actually fell
  // through, so an empty buffer doesn't carry a phantom zero-chip.
  const familyCounts = payloads.reduce((acc, p) => {
    const k = (p.vantaObject && p.vantaObject.type) || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const familyChips = [
    { key: 'questionnaire',  label: 'questionnaire',  cls: 'badge-family-questionnaire' },
    { key: 'accessRequest',  label: 'access request', cls: 'badge-family-access-request' },
    { key: 'vendorDecision', label: 'vendor decision', cls: 'badge-family-vendor-decision' }
  ]
    .map(({ key, label, cls }) => {
      const n = familyCounts[key] || 0;
      const emptyCls = n === 0 ? ' is-empty' : '';
      return `<span class="stat-chip${emptyCls}" title="${escapeHtml(label)} payloads"><strong>${n}</strong> ${escapeHtml(label)}</span>`;
    })
    .join('');
  const unknownChip = familyCounts.unknown
    ? `<span class="stat-chip" title="Payloads whose entity family could not be inferred"><strong>${familyCounts.unknown}</strong> unknown</span>`
    : '';

  const rows = payloads.length === 0
    ? `<tr><td colspan="6" class="empty-state">No payloads yet. Forward-on-receive lands payloads here as Vanta events arrive.</td></tr>`
    : payloads.map(renderWorkflowSinkRow).join('\n');

  return `
    <section class="card">
      <div class="card-header">
        <div class="card-pill source"><span class="dot"></span>Workflow Sink · destination</div>
        <h2>Downstream payloads</h2>
        <p class="subtitle">Where payloads land downstream. In a real integration: Jira, Linear, Slack, Salesforce, Coupa, or a homegrown GRC queue — the forward handler swaps out, the rest of the pipeline stays the same.<span class="subtitle-detail">Neutral payload — no priority baked in; the downstream system maps families to its own routing taxonomy. Buffer: ${bufferCap} entries, in-memory, resets on restart.</span></p>
      </div>
      <div class="card-body" id="workflowsink-body">
        <div class="hero-stat">
          <div class="hero-num">${payloads.length}</div>
          <div class="hero-label">payload${payloads.length === 1 ? '' : 's'}</div>
          <div class="stat-chips">${familyChips}${unknownChip}</div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Received</th>
              <th>Payload ID</th>
              <th>Family</th>
              <th>Summary</th>
              <th>Vanta event</th>
              <th>Vanta object</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
        <div class="endpoint-hint">GET /mock-workflow-sink/payloads.json · in-memory · resets on restart</div>
      </div>
    </section>
  `;
}

function renderWebhooksTab(webhooks) {
  if (!webhooks || !webhooks.secretConfigured) {
    return `
      <section class="card">
        <div class="card-header">
          <div class="card-pill warn"><span class="dot"></span>Setup needed</div>
          <h2>Vanta webhooks</h2>
          <p class="subtitle">Inbound deliveries from Vanta will be rejected with 503 until <code>VANTA_WEBHOOK_SECRET</code> is set in the environment. Configure the secret in your Vanta dashboard (Settings → Webhooks → endpoint secret), then redeploy.</p>
        </div>
        <div class="card-body" id="webhook-events-body">
          <p class="empty-state">Webhook secret unconfigured. Set <code>VANTA_WEBHOOK_SECRET</code> to start receiving events.</p>
        </div>
      </section>
    `;
  }

  const events = webhooks.events || [];
  const verified  = events.filter(e => e.verification?.ok).length;
  const deduped   = events.filter(e => e.dedupe?.status === 'duplicate').length;
  const rejected  = events.filter(e => !e.verification?.ok).length;
  const forwarded = events.filter(e => e.forward?.ok).length;
  const fwdFailed = events.filter(e => e.forward && !e.forward.ok).length;

  const rows = events.length === 0
    ? `<tr><td colspan="7" class="empty-state">No events received yet. Trigger one from Vanta UI → Settings → Webhooks → Send Example, or wait for a real event.</td></tr>`
    : events.map(renderWebhookEventRow).join('\n');

  // Stat chips break the previous middle-dot-separated label string into
  // discrete, scannable counts. is-empty dims a zero count so the chip
  // row reads at a glance ("nothing in this bucket"); is-warn flips the
  // forward-failed chip into the amber tone since a non-zero value there
  // means an operator should triage.
  const eventChips = `
    <span class="stat-chip${verified === 0 ? ' is-empty' : ''}"><strong>${verified}</strong> verified</span>
    <span class="stat-chip${deduped === 0 ? ' is-empty' : ''}"><strong>${deduped}</strong> deduped</span>
    <span class="stat-chip${rejected === 0 ? ' is-empty' : ''}"><strong>${rejected}</strong> rejected</span>
    <span class="stat-chip${forwarded === 0 ? ' is-empty' : ''}"><strong>${forwarded}</strong> forwarded</span>
    ${fwdFailed ? `<span class="stat-chip is-warn"><strong>${fwdFailed}</strong> forward-failed</span>` : ''}
  `;

  return `
    <section class="card">
      <div class="card-header">
        <div class="card-pill build"><span class="dot"></span>Vanta → LlamaLync · inbound</div>
        <h2>Webhook events</h2>
        <p class="subtitle">Vanta delivers webhooks via Svix — signature-verified (<code>{svix-id}.{svix-timestamp}.{body}</code> HMAC), deduped by <code>svix-id</code>, and forwarded synchronously to the Workflow Sink destination.<span class="subtitle-detail">At-least-once delivery means the same event may arrive twice — the dedupe column shows when. Buffer: ${webhookEventStore.MAX_EVENTS} entries, in-memory, resets on restart.</span></p>
        <div class="card-header-actions">
          <button class="btn btn-primary btn-sm" id="webhook-replay-btn" onclick="triggerWebhookReplay(false)" title="Synthesize a signed demo event (cycles through 4 sample types) and route it through the real receiver pipeline. Signed locally with VANTA_WEBHOOK_SECRET; NO Vanta API calls. Each click generates a fresh svix-id, so a new Workflow Sink payload appears each time.">Trigger demo event</button>
          <button class="btn btn-secondary btn-sm" id="webhook-replay-dedupe-btn" onclick="triggerWebhookReplay(true)" title="Re-send the last demo event with the SAME svix-id to exercise the at-least-once dedupe path. Receiver acks 200 + deduped; Workflow Sink does NOT create a duplicate payload.">Replay last (dedupe test)</button>
        </div>
      </div>
      <div class="card-body" id="webhook-events-body">
        <div class="hero-stat">
          <div class="hero-num">${events.length}</div>
          <div class="hero-label">recent event${events.length === 1 ? '' : 's'}</div>
          <div class="stat-chips">${eventChips}</div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Received</th>
              <th>Event type</th>
              <th>svix-id</th>
              <th>Signature</th>
              <th>Dedupe</th>
              <th>Forward</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
        <div class="endpoint-hint">POST /webhooks/vanta · Svix-signed · forwards in-process to Workflow Sink</div>
      </div>
    </section>

    ${renderWorkflowSinkCard(webhooks.workflowSink || { payloads: [], bufferCap: 50 })}
  `;
}

// ─── Scenario guide content + renderer (per scenario) ─────────────────────
// Each guide is intentionally tight: 1-line intro, 5-7 steps with at most 3
// callout quotes total, and 2 common questions. Goal is "an operator can
// navigate the scenario without external context"; not "every nuance is
// captured."

function renderDemoGuide({ intro, steps, questions }) {
  const stepsHtml = steps.map(s =>
    `<li>${s.step}${s.quote ? `<blockquote>${s.quote}</blockquote>` : ''}</li>`
  ).join('');
  const faqHtml = questions.map(q =>
    `<dt>Q: ${q.q}</dt><dd>A: ${q.a}</dd>`
  ).join('');
  return `
    <details class="demo-guide">
      <summary>
        <span class="demo-guide-chevron">▸</span>
        <span class="demo-guide-label">Guide</span>
      </summary>
      <div class="demo-guide-body">
        <p class="demo-guide-intro">${intro}</p>
        <ol class="demo-guide-steps">${stepsHtml}</ol>
        <h4>Common questions</h4>
        <dl class="demo-guide-faq">${faqHtml}</dl>
      </div>
    </details>
  `;
}

const DEMO_GUIDE_OVERVIEW = {
  intro: 'LlamaLync illustrates the two integration patterns most relevant to bespoke source systems: <strong>Build Integrations push</strong> (Personnel, Devices, Evidence) and <strong>Manage Vanta write</strong> (Risk). Start with Personnel and walk down the list.',
  steps: [
    { step: 'The Overview tab lists the five live scenarios. Pill colors signal the API surface: <strong>purple</strong> = Build Integrations; <strong>green</strong> = Manage Vanta.' },
    { step: 'Open <strong>Personnel</strong> — the most common bespoke-system scenario (homegrown HRIS).',
      quote: 'Two surfaces, two apps. A real integration that needs both is the default, not the edge case.' },
    { step: 'Open <strong>Devices</strong> — same push surface as Personnel, different schema family. Platform-specific resource types (macOS + Windows) and an honest Linux gap (no native resource type).' },
    { step: 'Open <strong>Evidence</strong> — third Build Integrations scenario, but multipart instead of JSON. Architectural twist: Vanta documents are a fixed catalog of evidence-request slots defined by your compliance program, not arbitrary uploads.' },
    { step: 'Open <strong>Risk</strong> — same kind of source system, different API surface. This is where Manage Vanta WRITE behavior diverges from Build Integrations PUT.' },
    { step: 'Open <strong>Compliance</strong> — same Manage Vanta surface as Risk, but read-only against tenant state.' },
    { step: 'Switch to <strong>Developer → Activity</strong> anytime to see wire-level Vanta API calls in real time.',
      quote: 'Every dashboard interaction maps to a real Vanta API call. The Activity tab is the ground truth.' }
  ],
  questions: [
    { q: 'Why does the integration need two apps?',
      a: 'Vanta enforces a hard split between Build Integrations and Manage Vanta. An app of one type cannot reach the other surface — by design, for least-privilege.' },
    { q: 'Is this deployable as-is?',
      a: 'It is a reference architecture, not a packaged product. Fork it, swap the mock source modules for your real systems, and deploy in your environment.' }
  ]
};

const DEMO_GUIDE_PERSONNEL = {
  intro: 'How a customer with a homegrown HRIS pushes <code>user_account</code> records into Vanta\'s Access Review module via the Build Integrations push surface. The IAM half of "employee data" — the HR half has no API path; see Q&amp;A below.',
  steps: [
    { step: 'The two cards show the <strong>People-X source</strong> roster (top) and the <strong>pushed user_accounts</strong> in Vanta (bottom).' },
    { step: 'Click <strong>+ Hire new employee</strong> — the source mutates and the mutation counter at the bottom of the source card increments.' },
    { step: 'Click <strong>Offboard</strong> on any active row — status flips to terminated in People-X (source-side only; Vanta is unaware until the next sync).' },
    { step: 'Click <strong>↻ Sync Now</strong> — Vanta receives the full snapshot in one <code>PUT</code>.',
      quote: 'Build Integrations PUT is full-snapshot. Anything missing from the payload gets soft-deleted in Vanta — that is how offboarding works.' },
    { step: 'Switch to <strong>Developer → Activity</strong> — the <code>PUT /v1/resources/user_account</code> call is logged with status and duration.' },
    { step: 'Back on Personnel — the terminated row now shows in the pushed card with <code>deletedAt</code> set.',
      quote: 'Mutations stay local until Sync is clicked. The operator controls timing — nothing flows to Vanta until they decide.' },
    { step: 'Note the source roster\'s <code>title</code> / <code>department</code> / <code>managerId</code> columns — visible in People-X, NOT pushed to Vanta. The Q&amp;A below explains why.',
      quote: 'Two categories of data: what custom integrations push (IAM identity, devices, vulns, risk, evidence), and what Vanta ingests via native connectors (HR / Person). Custom integrations cannot bridge into the second category — there is no API path.' }
  ],
  questions: [
    { q: 'Why doesn\'t this push job title / department?',
      a: 'Three writable surfaces were probed; all reject HR fields: (1) <code>PATCH /v1/people/{id}</code> rejects jobTitle / department / manager as "excess property"; (2) <code>user_account</code> top-level rejects HR fields as extras; (3) <code>user_account.customProperties</code> is rejected at runtime despite the JTD declaring it required. Custom integrations have no API path for HR data. Supported channels: native HRIS connectors (Workday / BambooHR / Rippling / Gusto), SCIM, CSV upload, manual UI entry. See <code>docs/scenarios/personnel.md</code>.' },
    { q: 'What about 50,000 employees?',
      a: 'Build Integrations rate-limit is 20/min. Batch payloads — full snapshot per sync still works at scale because it is one large PUT, not 50k small ones.' }
  ]
};

const DEMO_GUIDE_EVIDENCE = {
  intro: 'How a customer with a local compliance-evidence file store uploads documents to Vanta\'s <strong>pre-defined evidence-request slots</strong>. The architectural twist: Vanta "Documents" are not arbitrary uploads — they are a fixed catalog of slots defined by the tenant\'s compliance frameworks.',
  steps: [
    { step: 'The two cards show the <strong>Evidence-X file store</strong> (mock files with manifest-bound target slots) and the <strong>Vanta evidence-request slot catalog</strong> (the tenant\'s actual slot list, filtered to the slots the manifest targets).' },
    { step: 'Note the Vanta-side card\'s hero stat — N slots in the tenant, M flagged "Needs document". Each slot is one auditor-defined evidence requirement.',
      quote: 'Vanta\'s Documents API is not "upload arbitrary files" — it is "fulfill these specific evidence requests." The slot catalog IS the compliance program\'s evidence checklist.' },
    { step: 'Click <strong>Upload to Vanta</strong> on any file in the source card — multipart POST to <code>/v1/documents/{slot}/uploads</code>. The toast shows the response id and a "view in Vanta" link.' },
    { step: 'Click the "view in Vanta ↗" link in the source row (post-upload) — opens the slot\'s record in Vanta UI in a new tab. The file shows as "Manual Evidence" with the description, effectiveDate, and filename sent on the request.',
      quote: 'API-uploaded files always show as Manual Evidence in Vanta\'s UI — that is Vanta\'s auditor-facing label for integration-driven evidence vs Vanta-managed native-integration evidence. Filename, description, and effectiveDate are operator-controlled.' },
    { step: 'Switch to <strong>Developer → Activity</strong> — the <code>POST /v1/documents/access-requests/uploads → 200</code> call is logged. The activity log renders the multipart body as "(binary multipart body · N bytes)" since Buffers are not pretty-printed.' },
    { step: 'Expand the <strong>Show full tenant slot catalog</strong> disclosure on the Vanta-side card — surfaces all slots the tenant\'s frameworks defined, with their auditor-facing descriptions. Shows the scale of the evidence-collection workload before automation.' }
  ],
  questions: [
    { q: 'What if a needed slot is not in this list?',
      a: 'Slot creation is not exposed via the API — new slots come from the compliance program config in Vanta UI (adding a framework, adding a custom control). Add the slot in Vanta first, then the integration can push to it.' },
    { q: 'Can the "Manual Evidence" title be overridden?',
      a: 'No. Vanta hard-codes that title for API-uploaded files; it is the auditor-facing bucket separating integration evidence from native-integration evidence. Filename, description, and effectiveDate are operator-controlled.' }
  ]
};

const DEMO_GUIDE_DEVICES = {
  intro: 'How a customer with a homegrown CMDB / on-prem asset inventory pushes computer records into Vanta — via the <strong>Build Integrations push</strong> surface (same as Personnel), but with platform-specific resource types and an honest Linux gap.',
  steps: [
    { step: 'The four cards show: <strong>CMDB-X source</strong>, <strong>pushed computers</strong> (split by macOS / Windows), the <strong>Windows Security Center</strong> panel (six per-device enum signals), and the <strong>Unsupported (Linux)</strong> callout.' },
    { step: 'Note the source-card stats — orphans, unencrypted, unmanaged, stale check-in. These are real compliance gaps the integration surfaces declaratively.',
      quote: 'The source-system view IS the compliance view. The middleware is the lens that makes the gaps visible — auditors and SOC can both read this.' },
    { step: 'Click <strong>+ Onboard device</strong> — adds a new device to CMDB-X from a rotating pool (macOS → Windows → Linux). The mutation counter increments; the new device shows up immediately in the source table.' },
    { step: 'If the onboarded device was Linux, note it appearing in the <strong>Unsupported</strong> panel below — surfaced, not hidden.',
      quote: 'There is no native LinuxUserComputer resource type in Vanta. Linux is surfaced explicitly so the gap is visible to auditors, not silently filtered.' },
    { step: 'Click <strong>Reassign</strong> on any device row — the prompt asks for a new <code>assignedEmployeeId</code>. Try <code>emp-001</code> (Alice Nguyen) to reassign to a known-active employee, or leave blank to deliberately orphan the device. The new owner email resolves through People-X on the next Sync All.',
      quote: 'Owner attribution is what makes a device a compliance signal instead of an inventory row. Reassign + Sync All shows how middleware flows source-of-truth changes into Vanta\'s view without anyone clicking around in the Vanta UI.' },
    { step: 'Click <strong>↻ Sync All</strong> — two separate PUTs land (one per platform), and Linux is excluded. Toast shows the per-platform pushed counts plus the Linux skipped count.',
      quote: 'Two PUTs, two resource types, one source. macOS and Windows have distinct JTD schemas — applications carry bundleId on macOS, programs do not on Windows.' },
    { step: 'Open the <strong>Windows Security Center</strong> card — six independent enum-rated signals per device (firewall, antivirus, AutoUpdate, IE settings, UAC, WSC service). The badly-configured Windows VM (DEV-WIN-003) stands out at a glance with POOR badges.',
      quote: 'Windows-specific schema richness: macOS has a single isXProtectEnabled boolean, Windows has six independent signals. The dashboard\'s Windows row is louder for a reason.' },
    { step: 'Switch to <strong>Developer → Activity</strong> — the two <code>PUT /v1/resources/{Macos,Windows}UserComputer</code> calls are logged with status and duration.' }
  ],
  questions: [
    { q: 'Why are there two resource types, not one?',
      a: 'Vanta exposes <code>MacosUserComputer</code> and <code>WindowsUserComputer</code> as separate JTD-schema resource types. Their schemas share 15 of 16 required fields but diverge on inventory shape (applications vs programs), drive shape (filevaultEnabled is macOS-only), and platform-specific optionals (XProtect vs Windows Security Center).' },
    { q: 'What happens to Linux devices?',
      a: 'They surface in the Unsupported panel — visible but never pushed. There is no native Vanta base resource for Linux. Customers with a Linux subset either accept the audit gap, supply compensating evidence manually, or build a Build Integrations <em>custom</em> resource type on their tenant (out of scope for this scenario).' }
  ]
};

const DEMO_GUIDE_RISK = {
  intro: 'How a customer with a homegrown risk register mirrors risks into Vanta\'s native Risk module — via the <strong>Manage Vanta WRITE</strong> surface, not Build Integrations.',
  steps: [
    { step: 'The three cards show: <strong>Risk-X source</strong>, <strong>Vanta-side</strong> risk scenarios, and the <strong>5×5 inherent → residual matrix</strong>.' },
    { step: 'Click <strong>+ Add risk</strong> — simulates the security committee identifying a new risk; it lands as untreated (no residual scoring).' },
    { step: 'Click <strong>Apply treatment</strong> on the new untreated row — residual scoring drops below inherent.',
      quote: 'Apply treatment is the committee documenting that controls are in place. The residual delta is the audit-traceable proof treatment did something.' },
    { step: 'Click <strong>Mark closed</strong> on any open row — status flips in Risk-X (source-side only; closure mirrors to Vanta via a custom field, not a DELETE).' },
    { step: 'Click <strong>↻ Sync All</strong> — POST/PATCH lands; the banner shows owner emails not resolved to Vanta users.',
      quote: 'Manage Vanta WRITE, not Build Integrations. Different credential, different scope, different idempotency model. The banner is the integration being honest about cleanup work.' },
    { step: 'Switch to <strong>Developer → Activity</strong> — the <code>GET /v1/people</code> preflight, <code>GET /v1/risk-scenarios</code> list, and the <code>POST × N</code> burst are logged.' },
    { step: 'Open <strong>Vanta UI</strong> on any synced risk → Risk Management → click into a row → expand Custom Fields → note <code>Source Status: Closed</code> on a closed risk. That is the closure workaround visible to the auditor.' }
  ],
  questions: [
    { q: 'Why does Risk use a different API surface than Personnel?',
      a: 'Build Integrations <em>extends</em> Vanta with new resource types (custom user accounts). Manage Vanta <em>writes to</em> Vanta\'s native modules (Risk, Vendors). Same source-system pattern, different ingestion path depending on whether the target is native or custom.' },
    { q: 'Why no DELETE on closed risks?',
      a: 'Vanta\'s risk API has no public DELETE endpoint. Closure is mirrored via the <code>Source Status</code> custom field, which a Vanta-side auditor can see in the risk detail panel.' }
  ]
};

function renderComplianceCard(compliance) {
  if (compliance.error) {
    return `<div class="card-error">${escapeHtml(compliance.error)}</div>`;
  }
  // tone: 'neutral' for raw counts, 'good' when zero is the goal,
  // 'warn' when any non-zero is concerning, 'bad' for must-fix.
  // domId lets the auto-refresh script find each number to update in place.
  const sections = [
    { domId: 'm-controls',      label: 'Controls in framework',          key: 'controls.total',                      tone: 'neutral', endpoint: 'GET /v1/controls' },
    { domId: 'm-failing-tests', label: 'Failing tests',                  key: 'tests.failingCount',                  tone: 'warn',    endpoint: 'GET /v1/tests?outcome=FAIL' },
    { domId: 'm-vulns',         label: 'Vulns approaching SLA (7 days)', key: 'vulnerabilities.approachingSLACount', tone: 'bad',     endpoint: 'GET /v1/vulnerabilities?status=OPEN&remediationDeadlineBefore=…' },
    { domId: 'm-people',        label: 'People with overdue tasks',      key: 'people.overdueTaskCount',             tone: 'warn',    endpoint: 'GET /v1/people?hasOverdueSecurityTasks=true' }
  ];
  const get = (path) => path.split('.').reduce((o, k) => (o == null ? null : o[k]), compliance);
  const errored = (path) => {
    const top = path.split('.')[0];
    return compliance[top] && compliance[top].error;
  };

  const tone = (s, value) => {
    if (value === 0 || value == null) return 'tone-zero';
    if (s.tone === 'bad')  return 'tone-bad';
    if (s.tone === 'warn') return 'tone-warn';
    return 'tone-neutral';
  };

  const rows = sections.map(s => {
    const err = errored(s.key);
    const value = err ? null : get(s.key);
    const numHtml = err
      ? `<span class="errored" id="${s.domId}">read failed</span>`
      : `<span class="big-num ${tone(s, value)}" id="${s.domId}">${escapeHtml(value ?? 0)}</span>`;
    return `
      <div class="metric-row">
        <div class="metric-num">${numHtml}</div>
        <div class="metric-meta">
          <div class="metric-label">${escapeHtml(s.label)}</div>
          <div class="metric-endpoint">${escapeHtml(s.endpoint)}</div>
        </div>
      </div>
    `;
  }).join('');
  return `<div class="metrics">${rows}</div>`;
}

/**
 * Tenant ribbon shown in the header. Drives the "am I demoing against the
 * right tenant?" confidence check — without this, an SE running multiple
 * sandbox tenants has no visible cue which one LlamaLync is bound to.
 *
 * Three states based on env var combinations:
 *   - tenantName set + env=sandbox    → green / safe-to-experiment
 *   - tenantName set + env=production → red / customer-tenant warning
 *   - tenantName unset                → yellow / "configure VANTA_TENANT_NAME"
 *
 * Scheduler state (ENABLE_SCHEDULER) is surfaced inline since a scheduled
 * sync could mutate tenant state without operator input — the operator
 * should know if the dashboard is "passive" or "actively writing".
 */
function renderTenantRibbon() {
  const tenantName = process.env.VANTA_TENANT_NAME || '';
  const rawEnv = (process.env.VANTA_ENV || '').toLowerCase().trim();
  // Mirror the scheduler's own gating in src/scheduler/scheduler.js:
  // production turns it on regardless of the flag, the flag turns it on
  // outside production. Keep this in sync — a wrong "off" badge while the
  // scheduler is actually firing would be worse than no badge at all.
  const schedulerOn = process.env.NODE_ENV === 'production'
    || process.env.ENABLE_SCHEDULER === 'true';

  let envClass, envLabel, envTitle;
  if (!tenantName) {
    envClass = 'tenant-unconfigured';
    envLabel = 'UNCONFIGURED';
    envTitle = 'VANTA_TENANT_NAME is not set. The dashboard will still function but you have no visible safeguard against demoing against the wrong tenant. Set VANTA_TENANT_NAME in your .env to the subdomain shown in your Vanta UI URL.';
  } else if (rawEnv === 'production') {
    envClass = 'tenant-production';
    envLabel = 'PRODUCTION';
    envTitle = 'This deployment is bound to a PRODUCTION Vanta tenant. Every Sync All / Upload action writes to real customer data. Confirm twice before mutating.';
  } else if (rawEnv === 'sandbox') {
    envClass = 'tenant-sandbox';
    envLabel = 'SANDBOX';
    envTitle = 'This deployment is bound to a sandbox tenant — safe to experiment. Sync All / Upload actions write to the sandbox only.';
  } else {
    envClass = 'tenant-unverified';
    envLabel = rawEnv ? rawEnv.toUpperCase() : 'UNVERIFIED';
    envTitle = `VANTA_ENV is set to "${rawEnv}" which isn't a recognized value (expected "sandbox" or "production"). Ribbon is shown in warning color until you set one of those.`;
  }

  const tenantDisplay = tenantName || 'tenant unconfigured';
  const schedulerIndicator = schedulerOn
    ? `<span class="tenant-ribbon-scheduler tenant-ribbon-scheduler-on" title="Scheduled syncs are running on a cron timer. LlamaLync will overwrite records in Vanta with the current mock state at each tick — no operator click required. Production enables this automatically; outside production set ENABLE_SCHEDULER=true.">⏱ on</span>`
    : `<span class="tenant-ribbon-scheduler tenant-ribbon-scheduler-off" title="Scheduled syncs are disabled — Vanta records only change when you manually click Sync All / Upload / Reset. Set ENABLE_SCHEDULER=true to opt in locally.">⏱ off</span>`;

  return `
    <div class="tenant-ribbon ${envClass}" role="status" aria-label="Vanta tenant connection">
      <span class="tenant-ribbon-env" title="${escapeHtml(envTitle)}">${envLabel}</span>
      <span class="tenant-ribbon-name" title="VANTA_TENANT_NAME from .env. Pulled from the subdomain in your Vanta UI URL.">${escapeHtml(tenantDisplay)}</span>
      ${schedulerIndicator}
    </div>
  `;
}

function renderDashboard(data) {
  const { source, personnel, compliance, riskSource, riskPushed, deviceSource, devicePushed, evidenceSource, evidenceSlots, webhooks, generatedAt } = data;
  const buildIntegrationId = process.env.VANTA_INTEGRATION_ID || '—';
  const personnelResourceId = process.env.VANTA_PERSONNEL_RESOURCE_ID || '—';

  // Build an emp-id → email map once per render — used by the Devices tab
  // to resolve `assignedEmployeeId` to a Vanta-facing owner email. Reads the
  // same source-data roster that the Personnel tab already loaded, so this
  // doesn't trigger an extra People-X fetch.
  const employeeRoster = (source && source.roster) || [];
  const emailById = new Map(employeeRoster.map(e => [e.id, e.email]));
  // Refresh cadences:
  //   HEARTBEAT_MS — /health pulse, keeps the live-dot animated. Cheap.
  //   DATA_REFRESH_MS — full dashboard data (Source + Pushed + Compliance).
  //                     Each tick is ~7 Vanta API calls. Tab-visibility gated.
  //   ACTIVITY_REFRESH_MS — Activity sub-tab log. Tab-visibility AND tab-active gated.
  // Post-action handlers (Hire / Offboard / Sync) still trigger immediate refreshes,
  // so the natural workflow doesn't depend on the auto interval.
  const HEARTBEAT_MS = 30000;
  const DATA_REFRESH_MS = 5 * 60 * 1000;
  const ACTIVITY_REFRESH_MS = 30000;
  const REFRESH_MS = HEARTBEAT_MS; // legacy alias used by the old refresh function

  // Shared refresh-affordance block — propagated to every source card so the
  // live-dot + meta-stamp + ↻ refresh button is visually consistent across
  // tabs. Uses CLASS selectors (not IDs) so multiple instances can coexist
  // in the DOM. softRefresh() updates all .meta-stamp + .live-dot instances
  // via querySelectorAll (see the inline JS below).
  const refreshStatusHtml = `
    <div class="card-header-actions">
      <span class="refresh-status">
        <span class="live-dot"></span>
        <span class="meta-stamp">${escapeHtml(generatedAt.slice(11, 19))} UTC</span>
      </span>
      <button class="btn btn-icon" id="auto-refresh-toggle" title="Pause auto-refresh (data tick every ${DATA_REFRESH_MS / 60000} min). Heartbeat keeps running — it only hits /health, not Vanta." onclick="toggleAutoRefresh()">⏸</button>
      <button class="btn btn-icon" title="Refresh now (data auto-refreshes every ${DATA_REFRESH_MS / 60000} min when the tab is visible; heartbeat every ${HEARTBEAT_MS / 1000}s)" onclick="softRefresh()">↻</button>
    </div>
  `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>LlamaLync</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&display=swap">
  <style>
    /* Vanta brand palette — deep purple header, warm off-white body, brand
       purple accent for the push surface and brand green for the Manage surface.
       Reference colors:
         Vanta Purple       #AC55FF
         Vanta Dark Purple  #240642
         Vanta White        #F8F4F3
         Vanta Red          #F45B5B
         Vanta Yellow       #FFBE0F
         Vanta Green        #09C639
       (Brand yellow is too bright as a foreground on white — using a darker
       shade #B07A00 for warn text/numbers to keep WCAG-friendly contrast.) */
    :root {
      --bg: #f8f4f3;          /* Vanta White */
      --bg-2: #efe9e6;
      --card: #ffffff;
      --border: #e7dfdc;
      --border-strong: #c9bdb6;
      --text: #240642;        /* Vanta Dark Purple */
      --text-on-dark: #f8f4f3;
      --muted: #6e5a7c;
      --muted-2: #9787a0;
      --header-bg: #240642;   /* Vanta Dark Purple */
      --accent: #ac55ff;      /* Vanta Purple */
      --build: #ac55ff;       /* push surface — Vanta Purple */
      --build-bg: #f1e2ff;
      --manage: #09c639;      /* Manage surface — Vanta Green */
      --manage-bg: #dffae3;
      --bad: #f45b5b;         /* Vanta Red */
      --bad-bg: #fde5e5;
      --warn: #b07a00;        /* darker than Vanta Yellow #FFBE0F for legibility */
      --warn-bg: #fff3cc;
      --good: #09c639;        /* Vanta Green */
      --good-bg: #dffae3;
      --info: #ac55ff;        /* reuse Vanta Purple for info callouts */
      --info-bg: #f1e2ff;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      font-size: 14px;
    }

    /* ─── header (Vanta-style dark navy bar) ─── */
    header {
      background: var(--header-bg);
      color: var(--text-on-dark);
    }
    .header-inner {
      max-width: 1180px;
      margin: 0 auto;
      padding: 20px 32px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    /* Push the tabs/actions to the right so brand + ribbon sit on the left */
    .header-inner .header-actions { margin-left: auto; }
    .brand {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    /* Tenant ribbon — single most important "am I demoing against the right
       tenant?" signal. Always visible at the top of the page; color-coded by
       VANTA_ENV (sandbox / production / unconfigured / unverified). Sits
       next to the brand in the header so any SE can confirm tenant + env at
       a glance before clicking Sync All.
       Compound pill: env classification on the left, tenant name in mono on
       the right, scheduler-state indicator on the far right. */
    .tenant-ribbon {
      display: inline-flex;
      align-items: stretch;
      border-radius: 5px;
      overflow: hidden;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      line-height: 1;
      border: 1px solid transparent;
    }
    .tenant-ribbon-env {
      padding: 5px 10px;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.08em;
      white-space: nowrap;
      cursor: help;
    }
    .tenant-ribbon-name {
      padding: 5px 10px;
      font-family: var(--mono);
      font-weight: 500;
      letter-spacing: 0;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-on-dark);
      white-space: nowrap;
      cursor: help;
    }
    .tenant-ribbon-scheduler {
      padding: 5px 10px;
      font-weight: 500;
      letter-spacing: 0.02em;
      white-space: nowrap;
      cursor: help;
      border-left: 1px solid rgba(255, 255, 255, 0.12);
    }
    .tenant-ribbon-scheduler-off {
      background: rgba(255, 255, 255, 0.06);
      color: rgba(246, 247, 251, 0.75);
    }
    .tenant-ribbon-scheduler-on {
      /* Amber, not red — red reads as stop/error on a "running" indicator,
         and on a production deploy it would collide with the red PRODUCTION
         ribbon segment. Amber says "active, watch this" and rhymes with
         the withConfirm() pulse on tenant-touching buttons. */
      background: rgba(245, 158, 11, 0.22);
      color: #fbbf24;
    }

    /* Env-classification color variants. Each tints the env-label segment
       prominently; the tenant-name segment keeps a neutral dark background
       so the mono-font subdomain stays readable on all variants. */
    .tenant-ribbon.tenant-sandbox {
      border-color: rgba(34, 197, 94, 0.45);
    }
    .tenant-ribbon.tenant-sandbox .tenant-ribbon-env {
      background: rgba(34, 197, 94, 0.22);  /* green-ish — safe */
      color: #86efac;
    }
    .tenant-ribbon.tenant-production {
      border-color: rgba(239, 68, 68, 0.55);
    }
    .tenant-ribbon.tenant-production .tenant-ribbon-env {
      background: rgba(239, 68, 68, 0.32);
      color: #fecaca;
    }
    .tenant-ribbon.tenant-unconfigured,
    .tenant-ribbon.tenant-unverified {
      border-color: rgba(255, 190, 15, 0.45);
    }
    .tenant-ribbon.tenant-unconfigured .tenant-ribbon-env,
    .tenant-ribbon.tenant-unverified .tenant-ribbon-env {
      background: rgba(255, 190, 15, 0.22);
      color: #ffd166;
    }

    /* Responsive: collapse the scheduler indicator below 900px so the
       ribbon stays single-line. On very narrow screens (mobile), drop the
       env classification to icon-only — tenant name remains the priority. */
    @media (max-width: 900px) {
      .tenant-ribbon-scheduler { display: none; }
    }
    @media (max-width: 600px) {
      .tenant-ribbon-env {
        padding: 5px 7px;
        font-size: 10px;
      }
      .tenant-ribbon-name {
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
    header h1 {
      margin: 0;
      font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--text-on-dark);
    }
    header .tagline {
      margin-top: 2px;
      font-size: 12px;
      color: rgba(246, 247, 251, 0.65);
    }
    .tabs {
      display: flex;
      gap: 4px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      padding: 3px;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .signout-form { margin: 0; line-height: 0; }
    .signout-icon {
      background: transparent;
      border: 0;
      color: rgba(246, 247, 251, 0.55);
      padding: 7px 9px;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background 0.15s;
    }
    .signout-icon:hover {
      color: var(--text-on-dark);
      background: rgba(255, 255, 255, 0.08);
    }
    .signout-icon svg { display: block; }
    .tab {
      background: transparent;
      border: 0;
      color: rgba(246, 247, 251, 0.65);
      padding: 5px 14px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.1s, color 0.1s;
    }
    .tab:hover { color: var(--text-on-dark); }
    .tab.active {
      background: rgba(255, 255, 255, 0.15);
      color: var(--text-on-dark);
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* ─── Overview tab ───────────────────────────────────────────────── */
    .overview-hero {
      border-left: 4px solid var(--accent, #AC55FF);
    }
    .overview-hero h2 {
      font-size: 24px;
      margin: 0 0 6px;
    }

    .overview-scenarios {
      display: grid;
      /* Fixed 3-column grid so both the live (5 cards → 3+2) and planned
         (3 cards → 3+0) sections share the same column rhythm. An auto-fit
         grid drifted to 4 columns at desktop width, which left the 5th
         live card stranded alone on its own row — visually awkward and
         harder to scan. Collapse to 2 cols on tablet and 1 col on mobile. */
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      /* margin handled by parent's row-gap so the hero ↔ scenarios and
         scenarios ↔ reference gaps stay equal */
    }
    @media (max-width: 1000px) {
      .overview-scenarios { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 700px) {
      .overview-scenarios { grid-template-columns: 1fr; }
    }
    .overview-scenario {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      margin-bottom: 0; /* row gap handles spacing */
    }
    .overview-scenario h2 {
      font-size: 18px;
      margin: 4px 0 0;
    }
    .overview-scenario .subtitle {
      font-size: 13px;
    }
    .overview-scenario-actions {
      padding: 12px 20px 16px;
      display: flex;
      justify-content: flex-end;
    }

    /* "Planned" row — placeholder scenarios mapped to Vanta product themes
       not yet implemented. Subtly muted so the live scenarios above stay
       the visual focus, but still card-shaped so the roadmap is legible. */
    .overview-scenarios-planned {
      opacity: 0.85;
    }
    .overview-scenario-planned {
      background: #fafbfd;
    }
    .card-pill.planned {
      background: #eef0f3;
      color: var(--muted);
    }
    .card-pill.planned .dot {
      background: var(--muted);
    }
    .overview-scenario .btn:disabled,
    .overview-scenario .btn[disabled] {
      opacity: 0.45;
      cursor: not-allowed;
      pointer-events: none;
    }

    /* Reference card holds collapsible details — Architecture diagram and
       Glossary. Default closed so the landing stays focused on the hero
       + scenario boxes. */
    .overview-reference-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .overview-details {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0;
      background: #fafbfd;
    }
    .overview-details > summary {
      padding: 10px 14px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      list-style: none;
      user-select: none;
    }
    .overview-details > summary::-webkit-details-marker { display: none; }
    .overview-details > summary::before {
      content: '▸';
      display: inline-block;
      margin-right: 8px;
      transition: transform 0.15s;
      color: var(--muted);
    }
    .overview-details[open] > summary::before { transform: rotate(90deg); }
    .overview-details-hint {
      font-weight: 400;
      color: var(--muted);
      font-size: 12px;
    }
    .overview-details > *:not(summary) {
      padding: 0 14px 14px;
    }

    .overview-arch {
      display: flex;
      justify-content: center;
    }
    .overview-arch-svg {
      max-width: 100%;
      height: auto;
      width: 100%;
    }

    .overview-glossary {
      margin: 0;
      display: grid;
      grid-template-columns: minmax(160px, 220px) 1fr;
      gap: 8px 20px;
      font-size: 13px;
    }
    .overview-glossary dt {
      font-weight: 600;
      color: var(--text);
    }
    .overview-glossary dt code,
    .overview-glossary dd code {
      background: #eef0f3;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 12px;
    }
    .overview-glossary dd {
      margin: 0;
      color: var(--muted-2);
      line-height: 1.5;
    }
    @media (max-width: 700px) {
      .overview-glossary { grid-template-columns: 1fr; gap: 4px 0; }
      .overview-glossary dd { margin-bottom: 10px; }
    }

    /* Sub-tabs (inside the Developer tab) — light pill row matching the
       top-level tab visual language but on the white card background. */
    .sub-tabs {
      max-width: 1180px;
      margin: 24px auto 0;
      padding: 0 32px;
      display: flex;
      gap: 4px;
    }
    .sub-tabs::after {
      content: '';
      align-self: stretch;
      flex: 1;
      border-bottom: 1px solid var(--border);
      margin-bottom: 4px;
    }
    .sub-tab {
      background: transparent;
      border: 0;
      color: var(--muted);
      padding: 8px 16px;
      border-bottom: 2px solid transparent;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      transition: color 0.15s, border-color 0.15s;
      margin-bottom: -1px; /* overlap the divider so active state sits flush */
    }
    .sub-tab:hover { color: var(--text); }
    .sub-tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .subtab-panel { display: none; }
    .subtab-panel.active { display: block; }
    /* Refresh status — sits in the Source card's top-right */
    .refresh-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .live-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--good);
      /* Pulse uses Vanta Green RGB (9, 198, 57). Hardcoded because keyframe
         box-shadow doesn't accept var() reliably across browsers. */
      box-shadow: 0 0 0 0 rgba(9, 198, 57, 0.8);
    }
    .live-dot.pulse {
      animation: live-pulse 1.5s ease-out;
    }
    /* Paused state — the data tick is suspended. Mute the dot color and
       suppress any in-flight pulse animation so every source card visibly
       reflects the frozen state, not just the toggle button. */
    .live-dot.paused {
      background: var(--muted-2);
      box-shadow: none;
      animation: none;
    }
    @keyframes live-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(9, 198, 57, 0.8); }
      100% { box-shadow: 0 0 0 10px rgba(9, 198, 57, 0); }
    }
    .meta-stamp {
      font-variant-numeric: tabular-nums;
    }
    /* Default button — used in card content (light theme) */
    .btn {
      background: var(--card);
      border: 1px solid var(--border-strong);
      color: var(--text);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s, border-color 0.15s;
    }
    .btn:hover {
      background: var(--bg-2);
      border-color: var(--muted-2);
    }
    .btn-icon {
      padding: 7px 12px;
      font-size: 18px;
      line-height: 1;
    }

    /* ─── main grid ─── */
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px 32px 8px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: 24px;
      row-gap: 56px;       /* extra vertical separation: Source ↔ Pushed/Compliance are distinct concerns */
    }
    @media (max-width: 800px) {
      main { grid-template-columns: 1fr; row-gap: 32px; }
    }
    /* Single-card tabs (Compliance solo) get a single column so the card
       fills the width naturally instead of half-spanning a 2-col grid. */
    main.single-card {
      grid-template-columns: 1fr;
      row-gap: 0;
    }
    /* Overview is multi-card but each row is a logical band (hero, scenarios,
       reference), so it wants single-column layout. Row-gap matches the
       standard main element 56px so each band reads as its own section,
       not a cramped stack. The .tab-panel.active selector elsewhere forces
       display:block, so re-assert grid here with matching specificity. */
    main#tab-overview.tab-panel.active {
      display: grid;
      grid-template-columns: 1fr;
      row-gap: 36px;
    }

    /* ─── card ─── */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .card-header {
      padding: 18px 22px 14px;
      border-bottom: 1px solid var(--border);
    }
    .card-header-row {
      display: flex;
      align-items: flex-start;
      gap: 16px;
    }
    .card-header-main { flex: 1; min-width: 0; }
    .card-header-actions {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .card-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 3px 10px;
      border-radius: 12px;
      margin-bottom: 8px;
    }
    .card-pill.build  { background: var(--build-bg); color: var(--build); }
    .card-pill.manage { background: var(--manage-bg); color: var(--manage); }
    .card-pill.source { background: var(--bg-2); color: var(--muted); }
    .card-pill.warn   { background: #fef3c7; color: #92400e; }

    /* Pill + short directional descriptor pair — used on the Overview
       tiles. Pill carries the action verb (Push / Receive / Write /
       Read); the muted suffix carries the channel + direction
       ("to Vanta" / "webhooks from Vanta") so the pill itself stays
       a single-word focal point. Margin-bottom moves to the wrapper
       so the suffix and pill share one block of vertical space. */
    .card-pill-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .card-pill-row .card-pill { margin-bottom: 0; }
    .card-pill-detail {
      font-size: 11px;
      font-weight: 500;
      color: var(--muted-2);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    /* ─── source card (full-width, above the build/manage grid) ─── */
    .source-card { grid-column: 1 / -1; }
    .source-stats {
      display: flex;
      align-items: center;
      gap: 24px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    /* Grouped variant — used on the Devices source card to visually
       separate inventory stats (active / per-OS counts) from compliance-
       gap stats (orphan / unencrypted / unmanaged / stale). Each group
       gets its own gap-24 spacing; a subtle vertical rule sits between
       them. Wraps cleanly on narrow viewports — the divider becomes a
       horizontal rule when the row breaks. */
    .source-stats-grouped {
      gap: 32px;
    }
    .source-stats-group {
      display: flex;
      align-items: center;
      gap: 24px;
      flex-wrap: wrap;
    }
    .source-stats-divider {
      width: 1px;
      align-self: stretch;
      background: var(--border);
      margin: 4px 0;
    }
    @media (max-width: 720px) {
      .source-stats-divider {
        width: 100%;
        height: 1px;
        margin: 4px 0;
      }
    }
    .source-stat {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .source-num {
      font-size: 32px;
      font-weight: 600;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
      color: var(--text);
    }
    .source-num.muted { color: var(--muted-2); }
    .source-label {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .source-arrow {
      font-size: 22px;
      color: var(--muted-2);
      padding: 0 4px;
    }
    .source-flow-hint {
      font-size: 13px;
      color: var(--muted);
      padding: 10px 14px;
      background: var(--bg-2);
      border-radius: 6px;
      line-height: 1.45;
    }
    .source-flow-hint code {
      background: var(--card);
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 12px;
      border: 1px solid var(--border);
    }
    .roster-table {
      margin: 16px 0;
    }
    .roster-table th { font-size: 10px; }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--bg-2);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-active     { background: var(--good-bg);   color: var(--good); }
    .badge-terminated { background: var(--bad-bg);    color: var(--bad); }
    .badge-service    { background: var(--warn-bg);   color: var(--warn); }
    .badge-warn       { background: var(--warn-bg);   color: var(--warn); }
    .badge-good       { background: var(--good-bg);   color: var(--good); }
    .badge-bad        { background: var(--bad-bg);    color: var(--bad); }
    .badge-muted      { background: var(--bg-2);      color: var(--muted); }

    /* Events tab — Workflow Sink family badges. Color-by-family is
       categorical wayfinding (which entity), NOT priority. Hues are
       deliberately distinct from the semantic state palette
       (good=green, bad=red, warn=amber) and from the brand purple, so
       a row's family color and its state color can never collide. */
    .badge-family-questionnaire   { background: #dbeafe; color: #1e40af; }
    .badge-family-access-request  { background: #ccfbf1; color: #0f766e; }
    .badge-family-vendor-decision { background: #fce7f3; color: #9d174d; }

    /* Stat-chip row — replaces the long middle-dot-separated hero
       label with discrete count chips. Wraps gracefully on narrow
       viewports; aligns right within the hero-stat container. */
    .stat-chips {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-left: auto;
      align-items: center;
    }
    .stat-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      border-radius: 999px;
      background: var(--bg-2);
      color: var(--muted);
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.02em;
    }
    .stat-chip strong {
      font-weight: 700;
      color: var(--text);
    }
    .stat-chip.is-empty { opacity: 0.55; }
    .stat-chip.is-warn  { background: var(--warn-bg); color: var(--warn); }
    .stat-chip.is-warn  strong { color: var(--warn); }

    /* Secondary subtitle line — used on the Events tab cards to split
       the long architectural blurb into a primary one-liner + a
       smaller details line. Keeps the dense buffer/retention text
       legible without dominating the card header. */
    .subtitle-detail {
      display: block;
      margin-top: 6px;
      font-size: 12px;
      color: var(--muted-2);
    }

    /* svix-id truncation — ids are long and uniform-looking; ellipsize
       at a fixed width so the table stays scannable. Full id remains
       in the title tooltip and in the underlying DOM for copy/paste. */
    .webhook-svix-id {
      display: inline-block;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      vertical-align: middle;
    }

    /* OS badges on the Devices source table — distinct color per platform
       so the macOS / Windows / Linux split is scannable at a glance. The
       pill wraps a Simple Icons SVG logo (Apple / Windows / Tux); colors
       define the pill background + the logo fill (via currentColor). Linux
       keeps the warn tint to reinforce that it's surfaced-but-not-pushed,
       and carries an explicit ⚠ glyph alongside Tux so the "unsupported"
       signal reads independently of platform recognition. */
    .badge-os         {
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      line-height: 1;
    }
    .badge-os-macos   { background: #e0e7ff; color: #3730a3; }
    .badge-os-windows { background: #d1fae5; color: #047857; }
    .badge-os-linux   { background: var(--warn-bg); color: var(--warn); }
    .os-icon {
      width: 14px;
      height: 14px;
      fill: currentColor;
      flex-shrink: 0;
    }
    /* Warning glyph appended to the Linux OS pill (Tux + ⚠). Slightly
       smaller than the surrounding pill text so it reads as a marker, not
       a competing focal point. */
    .badge-os-warn {
      font-size: 11px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
    }

    /* Compliance signal badges in the Devices source table. Each device row
       carries a small cluster: encryption (FV / BL), screenlock (SL),
       managed (MGD), and on macOS, XProtect (XP). Three tones map to the
       posture: ok (green), warn (amber), bad (red). */
    .dev-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      margin-right: 3px;
      border-radius: 4px;
      font-family: var(--mono);
      letter-spacing: 0.02em;
    }
    .dev-badge-ok   { background: var(--good-bg); color: var(--good); }
    .dev-badge-warn { background: var(--warn-bg); color: var(--warn); }
    .dev-badge-bad  { background: var(--bad-bg);  color: var(--bad); }

    /* Windows Security Center pills — six signals per device, each with one
       of five enum-rated tones. POOR / NOT_MONITORED are red-ish (the
       compliance gaps to flag); SNOOZED + ERROR amber (worth surfacing,
       not necessarily failing); GOOD green; UNKNOWN gray fallback. */
    .wsc-table {
      margin: 8px 0;
    }
    .wsc-table th { font-size: 10px; }
    .wsc-pill {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      font-family: var(--mono);
      letter-spacing: 0.02em;
    }
    .wsc-good         { background: var(--good-bg); color: var(--good); }
    .wsc-poor         { background: var(--bad-bg);  color: var(--bad); }
    .wsc-snoozed      { background: var(--warn-bg); color: var(--warn); }
    .wsc-notmonitored { background: var(--bad-bg);  color: var(--bad); }
    .wsc-error        { background: var(--warn-bg); color: var(--warn); }
    .wsc-unknown      { background: var(--bg-2);    color: var(--muted-2); }

    /* Pushed-devices card layout: stacked per-platform sub-tables (macOS
       above Windows), each with its own GET endpoint hint. */
    .pushed-platforms {
      display: flex;
      flex-direction: column;
      gap: 24px;
      margin-top: 16px;
    }
    .pushed-platform h4 {
      margin: 0 0 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: 0.02em;
    }
    .pushed-platform-count {
      display: inline-block;
      margin-left: 8px;
      padding: 0 8px;
      border-radius: 10px;
      background: var(--build-bg);
      color: var(--build);
      font-size: 11px;
      font-weight: 600;
      vertical-align: middle;
    }

    /* Inline callout used inside the Unsupported (Linux) card — the
       existing .callout-warn is block-level with margin; the inline
       variant flows tighter with the table below it. */
    .callout-inline {
      margin-bottom: 12px;
      padding: 10px 14px;
    }

    /* ─── Evidence tab styles ─────────────────────────────────────────── */

    /* MIME-type pill on the source table — shows the second half of the
       MIME (csv, markdown, plain) with the full type in tooltip. Subtle
       to keep the eye on the filename column. */
    .mime-badge {
      font-family: var(--mono);
      font-size: 10px;
      background: var(--bg-2);
      color: var(--muted);
    }

    /* Slot id pill — visual cue that this column is "the Vanta-side
       identifier we map to". Subtle background like a badge but rendered
       in monospace to read as an id, not a label. */
    .evidence-slot-pill {
      display: inline-block;
      font-family: var(--mono);
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--build-bg);
      color: var(--build);
      letter-spacing: 0.01em;
    }

    /* Post-upload state — replaces the Upload button with a ✓ badge plus
       a "view in Vanta" link. Same alignment / spacing as the row-actions
       so the row height stays stable across the click. */
    .evidence-uploaded {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .evidence-uploaded-badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--good-bg);
      color: var(--good);
    }
    .evidence-view-link {
      font-size: 11px;
      color: var(--manage);
      text-decoration: none;
    }
    .evidence-view-link:hover {
      text-decoration: underline;
    }

    /* Session-upload marker — LlamaLync's own observation that a file
       landed in this slot during the current session, distinct from
       Vanta's uploadStatus (which lags). Sits next to the status badge
       in the same cell so "Needs document" plus "LL upload landed" sit
       side by side, making the gap visible at a glance. Muted
       green so it doesn't compete visually with the status badge but
       is still legible at a glance. */
    .evidence-session-marker {
      display: flex;
      align-items: center;
      gap: 5px;
      width: fit-content;
      margin-top: 10px;
      padding: 4px 9px;
      max-width: 280px;
      font-size: 10.5px;
      font-weight: 500;
      color: var(--good);
      background: var(--good-bg);
      border-radius: 4px;
      cursor: help;
      white-space: nowrap;
      overflow: hidden;
    }
    .evidence-session-marker-icon {
      flex-shrink: 0;
      stroke: currentColor;
    }
    /* Filename inside the marker truncates with ellipsis if longer than the
       marker's max-width allows. Keeps the @ time portion always visible. */
    .evidence-session-marker-name {
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      font-family: var(--mono);
      font-weight: 500;
    }

    /* Vanta-side slots card — the targeted slots get a small subheader so
       the "this is what our manifest pointed at" subset stands out from
       the wider tenant catalog (in the foldout below). */
    .evidence-slot-subheader {
      margin: 18px 0 4px;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .evidence-slot-subcount {
      font-size: 10px;
      font-weight: 500;
      color: var(--muted-2);
      text-transform: none;
      letter-spacing: 0;
      margin-left: 6px;
    }
    .evidence-slots-table {
      margin: 8px 0;
    }
    .evidence-slots-table th { font-size: 10px; }
    .evidence-slot-desc {
      font-size: 11px;
      color: var(--muted);
      max-width: 380px;
    }

    /* Full tenant catalog — disclosure that hides 50+ irrelevant slots
       by default. Same disclosure pattern as the compliance / WSC legends
       on the Devices tab. */
    .evidence-full-catalog {
      margin-top: 16px;
      background: var(--bg-2);
      border-radius: 6px;
      font-size: 11px;
    }
    .evidence-full-catalog > summary {
      list-style: none;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      color: var(--muted);
      font-weight: 600;
    }
    .evidence-full-catalog > summary::-webkit-details-marker { display: none; }
    .evidence-full-catalog-chevron {
      display: inline-block;
      font-size: 10px;
      color: var(--muted-2);
      transition: transform 0.12s ease;
      width: 10px;
      margin-right: 4px;
    }
    .evidence-full-catalog[open] > summary > .evidence-full-catalog-chevron {
      transform: rotate(90deg);
    }
    .evidence-slots-other {
      padding: 0 12px 12px;
    }

    /* Collapsible legends for the per-device compliance chips and the WSC
       pills. Default-closed so the dense Devices source card stays scannable;
       the summary line is a single-row affordance with a rotating chevron
       (matches the existing .demo-guide disclosure pattern). Click expands
       the full key with chip exemplars and labels. Chip tooltips still work
       independently for hover-decode. */
    .compliance-legend-details,
    .wsc-legend-details {
      margin: 4px 0 10px;
      background: var(--bg-2);
      border-radius: 6px;
      font-size: 11px;
      color: var(--muted);
    }
    .compliance-legend-details > summary,
    .wsc-legend-details > summary {
      list-style: none;
      padding: 6px 12px;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      line-height: 1.4;
    }
    /* Hide the default disclosure triangle in browsers that still draw it
       through ::-webkit-details-marker. The chevron span replaces it. */
    .compliance-legend-details > summary::-webkit-details-marker,
    .wsc-legend-details > summary::-webkit-details-marker { display: none; }
    .compliance-legend-chevron,
    .wsc-legend-chevron {
      display: inline-block;
      font-size: 10px;
      color: var(--muted-2);
      transition: transform 0.12s ease;
      width: 10px;
    }
    .compliance-legend-details[open] > summary > .compliance-legend-chevron,
    .wsc-legend-details[open] > summary > .wsc-legend-chevron {
      transform: rotate(90deg);
    }
    .compliance-legend-summary-label,
    .wsc-legend-summary-label {
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 10px;
      color: var(--muted-2);
    }
    .compliance-legend-summary-hint,
    .wsc-legend-summary-hint {
      font-size: 11px;
      color: var(--muted);
    }
    /* Expanded body — chip exemplars + labels, same row-flowing layout as
       the prior always-visible version. */
    .compliance-legend,
    .wsc-legend {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px 14px;
      padding: 4px 12px 10px;
      line-height: 1.5;
    }
    .compliance-legend-item,
    .wsc-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    /* Tone-only entries on the compliance legend (the trailing ✓ ✗ ✗ trio
       that explains what tone means independent of the FV/BL/SL/MGD/XP
       letters). Visually separated by a left rule so they read as a
       sub-cluster, not yet another chip type. */
    .compliance-legend-tone {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding-left: 14px;
      border-left: 1px solid var(--border);
    }
    .compliance-legend-tone:first-of-type {
      margin-left: 4px;
    }
    .row-action { text-align: right; min-width: 190px; }
    .row-actions {
      display: inline-flex;
      gap: 8px;
      justify-content: flex-end;
      align-items: center;
    }
    .row-note   { font-size: 11px; color: var(--muted-2); font-style: italic; }
    /* Wrapper that keeps the L×I notation and its untreated pill on one
       line. Without nowrap, the pill wraps below the score in narrow
       columns and creates row-height jitter. */
    .score-cell { white-space: nowrap; }
    /* Secondary signal that lives inside a scoring cell. Deliberately smaller
       and squarer than the status badges so it reads as a different category
       than open/closed — not a competing status. */
    .pill-untreated {
      display: inline-block;
      padding: 1px 6px;
      margin-left: 6px;
      background: var(--warn-bg);
      color: var(--warn);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      border-radius: 3px;
      vertical-align: middle;
    }
    .source-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .source-actions .mutations-hint {
      margin-left: auto;
      font-size: 12px;
      color: var(--muted);
    }
    .source-actions .mutations-hint a {
      color: var(--accent);
      text-decoration: none;
    }
    .source-actions .mutations-hint a:hover { text-decoration: underline; }
    /* Action buttons (light theme — body/cards) */
    .btn-primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .btn-primary:hover {
      background: #9a3def;
      border-color: #9a3def;
    }
    .btn-primary:disabled {
      background: var(--muted-2);
      border-color: var(--muted-2);
      cursor: wait;
    }
    .btn-secondary {
      background: var(--card);
      color: var(--text);
      border: 1px solid var(--border-strong);
    }
    .btn-secondary:hover {
      background: var(--bg-2);
    }
    .btn-danger {
      background: var(--card);
      color: var(--bad);
      border: 1px solid var(--bad-bg);
    }
    .btn-danger:hover {
      background: var(--bad-bg);
      border-color: var(--bad);
    }
    .btn-sm { padding: 3px 10px; font-size: 12px; }

    /* Reset-demo button — small, muted, sits alongside Sync All so SAs can
       restore baseline between demos. Tinted bad-foreground only on hover
       so the destructive intent is visible without dominating the row. */
    .btn-reset-demo {
      color: var(--muted);
      border-color: var(--border);
    }
    .btn-reset-demo:hover {
      color: var(--bad);
      border-color: var(--bad-bg);
      background: var(--bad-bg);
    }

    /* Confirm state — used by withConfirm() for tenant-touching actions
       (Sync All × 3, Upload Evidence). First click puts the button in this
       state; second click within 5s proceeds. Amber tone overrides any
       prior button variant (btn-primary, btn-sm, etc.) so the visual
       signal is unmistakable. Subtle pulse draws the eye without being
       distracting during a demo. */
    .btn.btn-confirming,
    .btn-confirming {
      background: #f59e0b !important;
      color: #fff !important;
      border-color: #d97706 !important;
      animation: confirm-pulse 1.4s ease-in-out infinite;
    }
    .btn.btn-confirming:hover,
    .btn-confirming:hover {
      background: #d97706 !important;
      border-color: #b45309 !important;
    }
    @keyframes confirm-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.55); }
      50%      { box-shadow: 0 0 0 5px rgba(245, 158, 11, 0); }
    }
    .card-pill .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: currentColor;
    }
    .card h2 {
      margin: 0 0 4px;
      font-size: 16px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .card .subtitle {
      margin: 0;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.45;
    }
    .card-body {
      padding: 18px 22px 20px;
      flex: 1;
    }

    /* ─── hero-stat (pushed card) ─── */
    .hero-stat {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 14px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    .hero-num {
      font-size: 36px;
      font-weight: 600;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      color: var(--text);
    }
    .hero-label {
      font-size: 14px;
      color: var(--muted);
    }

    /* ─── tables (pushed) ─── */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      font-weight: 600;
      color: var(--muted-2);
      border-bottom: 1px solid var(--border);
      padding: 6px 10px 6px 0;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    td {
      padding: 8px 10px 8px 0;
      border-bottom: 1px solid var(--border);
    }
    tr:last-child td { border-bottom: 0; }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--muted);
    }
    td.muted { color: var(--muted-2); font-size: 12px; font-variant-numeric: tabular-nums; }

    /* ─── compliance metrics ─── */
    .metrics {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .metric-row {
      display: grid;
      grid-template-columns: 64px 1fr;
      gap: 14px;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }
    .metric-row:last-child { border-bottom: 0; }
    .metric-num {
      text-align: right;
    }
    .big-num {
      font-size: 28px;
      font-weight: 600;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .big-num.tone-zero    { color: var(--good); }
    .big-num.tone-neutral { color: var(--text); }
    .big-num.tone-warn    { color: var(--warn); }
    .big-num.tone-bad     { color: var(--bad); }
    .metric-label {
      font-size: 14px;
      font-weight: 500;
      color: var(--text);
    }
    .metric-endpoint {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: var(--muted-2);
      margin-top: 2px;
    }

    /* ─── callouts ─── */
    .callout {
      margin-top: 14px;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.45;
    }
    .callout-info {
      background: var(--info-bg);
      color: var(--info);
      border-left: 3px solid var(--info);
    }
    .callout-success {
      background: var(--good-bg);
      color: var(--good);
      border-left: 3px solid var(--good);
    }
    .callout-warn {
      background: var(--warn-bg);
      color: var(--warn);
      border-left: 3px solid var(--warn);
    }
    /* Links inside a warn callout should read as part of the warning, not
       as a product accent link. Scoped tightly so other callout variants
       keep their existing link styling. */
    .callout-warn a {
      color: var(--warn);
      text-decoration: underline;
      text-underline-offset: 2px;
      font-weight: 600;
    }
    .callout-warn a:hover { text-decoration: none; }
    .callout strong { font-weight: 600; }

    /* ─── Demo guide (collapsible <details>) ─────────────────────────────
       Sits above the first card on Overview / Personnel / Risk tabs.
       Collapsed by default so a live demo audience never sees it open;
       the operator expands while preparing, collapses before presenting. */
    .demo-guide {
      margin: 0 0 18px;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
      background: var(--card, #ffffff);
    }
    /* Overview uses display:grid with row-gap:36px so each child also gets
       36px below it. The demo-guide is meta content (not a "band" like the
       hero/scenarios/reference sections), so we cancel the band gap with a
       negative bottom margin — the visible gap below the guide then lands
       at the same ~18px Personnel/Risk show in normal block flow. */
    main#tab-overview.tab-panel.active > .demo-guide {
      margin-bottom: -18px;
    }
    .demo-guide > summary {
      cursor: pointer;
      list-style: none;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--text);
      user-select: none;
    }
    .demo-guide > summary::-webkit-details-marker { display: none; }
    .demo-guide > summary:hover { background: rgba(0,0,0,0.02); }
    .demo-guide-chevron {
      display: inline-block;
      transition: transform 0.15s ease;
      font-size: 10px;
      color: var(--muted);
    }
    .demo-guide[open] > summary .demo-guide-chevron {
      transform: rotate(90deg);
    }
    .demo-guide-label {
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .demo-guide-body {
      padding: 12px 16px 14px;
      font-size: 13px;
      line-height: 1.55;
      border-top: 1px solid var(--border, #e5e7eb);
    }
    .demo-guide-intro {
      margin: 0 0 12px;
      color: var(--text);
    }
    .demo-guide-steps {
      margin: 0 0 14px;
      padding-left: 22px;
    }
    .demo-guide-steps li { margin-bottom: 8px; }
    .demo-guide-steps blockquote {
      margin: 6px 0 0;
      padding: 6px 10px;
      border-left: 2px solid var(--accent, #a78bfa);
      background: rgba(0,0,0,0.025);
      font-style: italic;
      font-size: 12px;
      color: var(--muted-2, #4b5563);
      border-radius: 3px;
    }
    .demo-guide-body h4 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin: 0 0 6px;
      font-weight: 600;
    }
    .demo-guide-faq { margin: 0; }
    .demo-guide-faq dt { font-weight: 600; margin-top: 6px; }
    .demo-guide-faq dd { margin: 2px 0 8px; color: var(--muted-2, #4b5563); }

    /* ─── Risk matrix (slice 5.3) ───────────────────────────────────────
       SVG-rendered 5×5 heatmap. Cells fill by L×I tier (green→red).
       Inherent dots are aggregated per cell with a count badge.
       Treated risks draw an arrow from inherent → residual position. */
    .risk-matrix-wrap {
      display: flex;
      justify-content: center;
      padding: 16px 0 8px;
    }
    .risk-matrix-svg {
      max-width: 560px;
      width: 100%;
      height: auto;
      font-family: inherit;
    }
    .matrix-cell {
      stroke: #ffffff;
      stroke-width: 2;
    }
    .matrix-cell-1 { fill: #d4f0d8; } /* low */
    .matrix-cell-2 { fill: #ecedaa; } /* medium-low */
    .matrix-cell-3 { fill: #f3d182; } /* medium */
    .matrix-cell-4 { fill: #efa278; } /* high */
    .matrix-cell-5 { fill: #e57878; } /* critical */
    .matrix-axis-label {
      font-size: 13px;
      fill: var(--text);
      font-weight: 600;
      text-anchor: middle;
    }
    .matrix-axis-title {
      font-size: 11px;
      fill: var(--text);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      text-anchor: middle;
    }
    .risk-dot-inherent {
      fill: #1f2937;
      stroke: #ffffff;
      stroke-width: 2;
    }
    .risk-dot-residual {
      fill: #ffffff;
      stroke: #1f2937;
      stroke-width: 2;
    }
    .risk-count-badge {
      font-size: 11px;
      font-weight: 700;
      fill: #ffffff;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
    }
    .risk-arrow {
      stroke: #374151;
      stroke-width: 1.8;
      fill: none;
      opacity: 0.55;
    }
    .matrix-legend {
      display: flex;
      gap: 20px;
      justify-content: center;
      font-size: 12px;
      color: var(--text);
      padding: 6px 0 0;
      flex-wrap: wrap;
    }
    .matrix-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .matrix-legend-swatch {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      display: inline-block;
    }
    .matrix-legend-swatch.inherent {
      background: #1f2937;
      border: 2px solid #ffffff;
      box-shadow: 0 0 0 1px #1f2937;
    }
    .matrix-legend-swatch.residual {
      background: #ffffff;
      border: 2px solid #1f2937;
    }
    .matrix-legend-arrow {
      display: inline-block;
      width: 26px;
      height: 2px;
      background: #374151;
      opacity: 0.55;
      position: relative;
    }
    .matrix-legend-arrow::after {
      content: '';
      position: absolute;
      right: -2px;
      top: -3px;
      width: 0;
      height: 0;
      border-left: 6px solid #374151;
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      opacity: 0.55;
    }

    /* ─── endpoint hint at card bottom ─── */
    .endpoint-hint {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: var(--muted-2);
    }

    /* ─── error / empty states ─── */
    .card-error {
      color: var(--bad);
      font-family: ui-monospace, monospace;
      font-size: 13px;
      padding: 12px;
      background: var(--bad-bg);
      border-radius: 4px;
    }
    .empty {
      color: var(--muted);
      padding: 8px 0;
      font-size: 13px;
    }
    .empty code {
      background: #eef0f3;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 12px;
    }
    .errored {
      color: var(--warn);
      font-style: italic;
      font-size: 13px;
    }

    /* ─── activity tab ─── */
    .activity-list {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px 32px 8px;
    }
    .activity-empty {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 32px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
    }
    .activity-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
      font-size: 13px;
      color: var(--muted);
    }
    .activity-toolbar .btn { margin-left: auto; }
    .activity-row {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .activity-row-header {
      display: grid;
      grid-template-columns: 80px 70px 1fr 70px 70px 28px;
      gap: 14px;
      align-items: center;
      padding: 10px 16px;
      cursor: pointer;
      user-select: none;
    }
    .activity-row-header:hover { background: var(--bg-2); }
    .activity-time {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: var(--muted-2);
      font-variant-numeric: tabular-nums;
    }
    .activity-app {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 8px;
      border-radius: 10px;
      text-align: center;
    }
    .activity-app.build  { background: var(--build-bg);  color: var(--build); }
    .activity-app.manage { background: var(--manage-bg); color: var(--manage); }
    .activity-method-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .activity-method {
      font-weight: 600;
      margin-right: 8px;
    }
    .activity-status {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      font-weight: 600;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .activity-status.s2xx { color: var(--good); }
    .activity-status.s4xx { color: var(--warn); }
    .activity-status.s5xx { color: var(--bad); }
    .activity-duration {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      color: var(--muted-2);
      text-align: right;
    }
    .activity-chevron {
      color: var(--muted-2);
      font-size: 11px;
      transition: transform 0.15s;
    }
    .activity-row.expanded .activity-chevron { transform: rotate(90deg); }
    .activity-body {
      display: none;
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border);
      background: #fafbfd;
    }
    .activity-row.expanded .activity-body { display: block; }
    .activity-section {
      margin-bottom: 10px;
    }
    .activity-section:last-child { margin-bottom: 0; }
    .activity-section-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .activity-json {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.5;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      overflow-x: auto;
      margin: 0;
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .activity-json .json-string  { color: #b07a00; }
    .activity-json .json-number  { color: var(--build); }
    .activity-json .json-boolean { color: var(--manage); font-weight: 600; }
    .activity-json .json-null    { color: var(--muted-2); font-style: italic; }
    .activity-json .json-key     { color: var(--text); font-weight: 500; }
    .activity-error {
      color: var(--bad);
      font-family: ui-monospace, monospace;
      font-size: 12px;
      padding: 8px 10px;
      background: var(--bad-bg);
      border-radius: 4px;
    }

    /* ─── explorer tab ─── */
    .explorer {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px 32px 8px;
    }
    .explorer-intro {
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .explorer-intro ul {
      margin: 6px 0;
      padding-left: 20px;
    }
    .explorer-intro li { margin: 2px 0; }
    .explorer-intro strong { color: var(--text); font-weight: 600; }
    .explorer-import {
      margin-bottom: 12px;
    }
    .explorer-import-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .explorer-import-btn {
      cursor: pointer;
    }
    .explorer-import-status {
      font-size: 12px;
    }
    .explorer-import-status.error { color: var(--bad); }
    .explorer-import-status.ok    { color: var(--muted-2); }

    .explorer-preset-meta {
      font-size: 12px;
      color: var(--muted-2);
      margin-top: 8px;
      padding: 8px 10px;
      background: #f6f7f9;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .explorer-vars,
    .explorer-headers {
      margin-top: 12px;
      padding: 10px;
      background: #f9fafc;
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .explorer-vars-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .explorer-vars-rows {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .explorer-var-row {
      display: grid;
      grid-template-columns: minmax(140px, 220px) 1fr auto;
      gap: 8px;
      align-items: center;
      font-size: 13px;
    }
    .explorer-var-row .var-key {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--text);
    }
    .explorer-var-row .var-key.required::after {
      content: ' *';
      color: var(--bad);
    }
    .explorer-var-row input[type="text"] {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 3px;
      background: white;
    }
    .explorer-var-row input[type="text"].invalid {
      border-color: var(--bad);
      background: var(--bad-bg);
    }
    .explorer-var-row .var-checkbox {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--muted);
    }
    .explorer-headers .header-row {
      display: flex;
      gap: 8px;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 2px 0;
    }
    .explorer-headers .header-row .header-key {
      color: var(--muted);
      min-width: 140px;
    }

    .explorer-body-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .explorer-body-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .explorer-validate-status {
      font-size: 12px;
    }
    .explorer-validate-status.ok { color: var(--good); }
    .explorer-validate-status.error { color: var(--bad); }

    .explorer-presets {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
    }
    .explorer-presets-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      flex-shrink: 0;
    }
    #exp-preset {
      flex: 1;
      max-width: 360px;
      font-family: inherit;
      font-size: 13px;
      padding: 7px 10px;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #exp-preset:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(172, 85, 255, 0.15);
    }
    .explorer-form {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px 20px;
      margin-bottom: 18px;
    }
    .explorer-row {
      display: grid;
      grid-template-columns: 160px 110px 1fr;
      gap: 10px;
      margin-bottom: 12px;
    }
    .explorer-row > label,
    .explorer-body-label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }
    .explorer-form select,
    .explorer-form input[type="text"],
    .explorer-form textarea {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      padding: 8px 10px;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      background: #fafbfd;
      color: var(--text);
      transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
    }
    .explorer-form select:focus,
    .explorer-form input[type="text"]:focus,
    .explorer-form textarea:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--card);
      box-shadow: 0 0 0 3px rgba(172, 85, 255, 0.15);
    }
    .explorer-form textarea {
      width: 100%;
      resize: vertical;
      min-height: 220px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 1.45;
    }
    .explorer-body-label { text-transform: none; letter-spacing: normal; font-weight: 500; }
    .explorer-warning {
      margin: 0 0 12px;
      padding: 8px 12px;
      background: var(--warn-bg);
      color: var(--warn);
      border-left: 3px solid var(--warn);
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.45;
    }
    .explorer-warning strong { font-weight: 600; }
    .explorer-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 14px;
    }
    .explorer-status {
      font-size: 12px;
      color: var(--muted);
      font-family: ui-monospace, monospace;
    }
    .explorer-status.error { color: var(--bad); }
    .explorer-response {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 18px;
    }
    .explorer-response .activity-json {
      min-height: 240px;
      max-height: 600px;
      overflow: auto;
      resize: vertical;
    }
    .explorer-response-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 10px;
    }
    .explorer-response-header > span:first-child {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .explorer-response-meta {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      color: var(--muted);
    }
    .explorer-response-meta .status { font-weight: 600; }
    .explorer-response-meta .status.s2xx { color: var(--good); }
    .explorer-response-meta .status.s4xx { color: var(--warn); }
    .explorer-response-meta .status.s5xx { color: var(--bad); }

    /* ─── toasts ─── */
    .toast-container {
      position: fixed;
      top: 80px;
      right: 24px;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      background: var(--card);
      border: 1px solid var(--border-strong);
      border-left: 3px solid var(--good);
      border-radius: 6px;
      padding: 10px 16px;
      font-size: 13px;
      color: var(--text);
      box-shadow: 0 4px 12px rgba(36, 6, 66, 0.08);
      min-width: 240px;
      max-width: 380px;
      transform: translateX(120%);
      opacity: 0;
      transition: transform 0.25s ease-out, opacity 0.25s ease-out;
      pointer-events: auto;
    }
    .toast.show {
      transform: translateX(0);
      opacity: 1;
    }
    .toast-info    { border-left-color: var(--accent); }
    .toast-success { border-left-color: var(--good); }
    .toast-error   { border-left-color: var(--bad); }
    .toast strong { font-weight: 600; }
    .toast-detail {
      display: block;
      margin-top: 2px;
      font-size: 12px;
      color: var(--muted);
    }

    /* ─── new-row highlight (Activity tab) ─── */
    @keyframes row-flash {
      0%   { background: var(--good-bg); }
      100% { background: var(--card); }
    }
    .activity-row.fresh {
      animation: row-flash 2.5s ease-out;
    }

    /* ─── footer — sticky status bar at viewport bottom ──────────────────
       Holds integration / resource metadata, /health pulse, and the tenant
       ribbon. Position-fixed so the ribbon stays at-a-glance regardless of
       scroll position; the ribbon's whole job is "tenant safety," and a
       footer that disappears when the page scrolls would defeat that.
       Dark navy bg mirrors the header so the ribbon's translucent overlays
       (designed for the navy header) render correctly here too. */
    footer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 50;
      background: var(--header-bg);
      color: var(--muted-2);
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 11px;
      font-family: ui-monospace, monospace;
    }
    .footer-inner {
      max-width: 1180px;
      margin: 0 auto;
      padding: 8px 32px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      /* Tightened from 24px column-gap to 12px to keep the tenant ribbon
         on the same row after the GitHub source-link was added — the
         extra ~70px tipped the row past the 1180px max-width and caused
         the ribbon to wrap to a second line. */
      gap: 6px 12px;
    }
    /* Push the tenant ribbon to the far right of the footer. */
    .footer-tenant { margin-left: auto; }
    footer a { color: rgba(246, 247, 251, 0.65); text-decoration: none; }
    footer a:hover { color: var(--text-on-dark); text-decoration: underline; }
    .github-link {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      vertical-align: middle;
    }
    .github-icon {
      width: 12px;
      height: 12px;
      fill: currentColor;
      display: block;
    }
    /* Clear the fixed footer so the last bit of page content isn't covered. */
    body { padding-bottom: 52px; }
    .health-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      line-height: 1;
    }
    .health-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--good);
      box-shadow: 0 0 0 0 rgba(9, 198, 57, 0.8);
      transition: background 0.2s;
    }
    .health-indicator.pulse .health-dot {
      animation: live-pulse 1.5s ease-out;
    }
    .health-indicator.stale .health-dot { background: var(--warn); animation: none; }
    .health-indicator.down  .health-dot { background: var(--bad);  animation: none; }
    .health-label { color: rgba(246, 247, 251, 0.65); }
    .health-indicator.stale .health-label { color: #ffd166; }
    .health-indicator.down  .health-label { color: #fecaca; }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="brand">
        <h1>LlamaLync</h1>
        <div class="tagline">Vanta middleware demo</div>
      </div>
      <div class="header-actions">
        <div class="tabs">
          <button class="tab active" data-tab="overview"   onclick="switchTab('overview')">Overview</button>
          <button class="tab"        data-tab="personnel"  onclick="switchTab('personnel')">Personnel</button>
          <button class="tab"        data-tab="devices"    onclick="switchTab('devices')">Devices</button>
          <button class="tab"        data-tab="evidence"   onclick="switchTab('evidence')">Evidence</button>
          <button class="tab"        data-tab="events"     onclick="switchTab('events')">Events</button>
          <button class="tab"        data-tab="risk"       onclick="switchTab('risk')">Risk</button>
          <button class="tab"        data-tab="compliance" onclick="switchTab('compliance')">Compliance</button>
          <button class="tab"        data-tab="developer"  onclick="switchTab('developer')">Developer</button>
        </div>
        <form method="POST" action="/logout" class="signout-form">
          <button type="submit" class="signout-icon" title="Sign out" aria-label="Sign out">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
          </button>
        </form>
      </div>
    </div>
  </header>

  <main id="tab-overview" class="tab-panel active">
    ${renderDemoGuide(DEMO_GUIDE_OVERVIEW)}
    <section class="card overview-hero">
      <div class="card-header">
        <h2>LlamaLync</h2>
        <p class="subtitle">When a customer's source-of-truth system isn't on Vanta's native integration list, they bridge it with custom middleware. LlamaLync is that pattern — each scenario below is a real bridge customers have asked for.</p>
      </div>
    </section>

    <div class="overview-scenarios">
      <section class="card overview-scenario">
        <div class="card-header">
          <div class="card-pill-row">
            <div class="card-pill build"><span class="dot"></span>Push</div>
            <span class="card-pill-detail">→ Vanta</span>
          </div>
          <h2>Personnel</h2>
          <p class="subtitle">Keep Vanta's employee roster in sync with a bespoke HRIS so Access Reviews and people-related controls stay current without manual import.</p>
        </div>
        <div class="overview-scenario-actions">
          <button class="btn btn-primary btn-sm" onclick="switchTab('personnel')">Open Personnel</button>
        </div>
      </section>

      <section class="card overview-scenario">
        <div class="card-header">
          <div class="card-pill-row">
            <div class="card-pill build"><span class="dot"></span>Push</div>
            <span class="card-pill-detail">→ Vanta</span>
          </div>
          <h2>Devices</h2>
          <p class="subtitle">Bring devices from a homegrown CMDB or asset inventory into Vanta so endpoint controls (encryption, MDM, screenlock) evidence themselves.</p>
        </div>
        <div class="overview-scenario-actions">
          <button class="btn btn-primary btn-sm" onclick="switchTab('devices')">Open Devices</button>
        </div>
      </section>

      <section class="card overview-scenario">
        <div class="card-header">
          <div class="card-pill-row">
            <div class="card-pill build"><span class="dot"></span>Push</div>
            <span class="card-pill-detail">→ Vanta</span>
          </div>
          <h2>Evidence</h2>
          <p class="subtitle">Auto-upload compliance evidence — policies, attestations, exports — from an internal file store to the right Vanta control requirement, instead of doing it by hand every audit.</p>
        </div>
        <div class="overview-scenario-actions">
          <button class="btn btn-primary btn-sm" onclick="switchTab('evidence')">Open Evidence</button>
        </div>
      </section>

      <section class="card overview-scenario">
        <div class="card-header">
          <div class="card-pill-row">
            <div class="card-pill build"><span class="dot"></span>Receive</div>
            <span class="card-pill-detail">← Vanta webhook</span>
          </div>
          <h2>Events</h2>
          <p class="subtitle">Receive Vanta webhooks in real time and forward them to a downstream compliance workflow system — Jira, Slack, Salesforce, or a homegrown GRC queue.</p>
        </div>
        <div class="overview-scenario-actions">
          <button class="btn btn-primary btn-sm" onclick="switchTab('events')">Open Events</button>
        </div>
      </section>

      <section class="card overview-scenario">
        <div class="card-header">
          <div class="card-pill-row">
            <div class="card-pill manage"><span class="dot"></span>Write</div>
            <span class="card-pill-detail">→ Vanta</span>
          </div>
          <h2>Risk</h2>
          <p class="subtitle">Mirror a homegrown risk register into Vanta's Risk module so the SOC 2 and ISO 27001 risk-management controls have evidence without double-entry.</p>
        </div>
        <div class="overview-scenario-actions">
          <button class="btn btn-primary btn-sm" onclick="switchTab('risk')">Open Risk</button>
        </div>
      </section>

      <section class="card overview-scenario">
        <div class="card-header">
          <div class="card-pill-row">
            <div class="card-pill manage"><span class="dot"></span>Read</div>
            <span class="card-pill-detail">← Vanta</span>
          </div>
          <h2>Compliance</h2>
          <p class="subtitle">Read Vanta's live compliance signal — control health, failing tests, vulnerabilities, people tasks — to embed in internal dashboards or executive reports.</p>
        </div>
        <div class="overview-scenario-actions">
          <button class="btn btn-primary btn-sm" onclick="switchTab('compliance')">Open Compliance</button>
        </div>
      </section>
    </div>

    <div class="overview-scenarios overview-scenarios-planned">
      <section class="card overview-scenario overview-scenario-planned">
        <div class="card-header">
          <div class="card-pill planned"><span class="dot"></span>Planned</div>
          <h2>Vendors</h2>
          <p class="subtitle">Reflect the vendor catalog and security-review status from procurement into Vanta Vendor Management.</p>
        </div>
        <div class="overview-scenario-actions">
          <button class="btn btn-secondary btn-sm" disabled aria-disabled="true">Open Vendors</button>
        </div>
      </section>

      <section class="card overview-scenario overview-scenario-planned">
        <div class="card-header">
          <div class="card-pill planned"><span class="dot"></span>Planned</div>
          <h2>Vulnerabilities</h2>
          <p class="subtitle">Push findings from an on-prem or proprietary scanner into Vanta for SLA tracking and audit evidence.</p>
        </div>
        <div class="overview-scenario-actions">
          <button class="btn btn-secondary btn-sm" disabled aria-disabled="true">Open Vulnerabilities</button>
        </div>
      </section>

      <section class="card overview-scenario overview-scenario-planned">
        <div class="card-header">
          <div class="card-pill planned"><span class="dot"></span>Planned</div>
          <h2>Customer Trust</h2>
          <p class="subtitle">Keep Vanta Trust Center content — FAQs, subprocessor list, policies — in sync with internal sources, no manual updates.</p>
        </div>
        <div class="overview-scenario-actions">
          <button class="btn btn-secondary btn-sm" disabled aria-disabled="true">Open Customer Trust</button>
        </div>
      </section>
    </div>

    <section class="card overview-reference">
      <div class="card-header">
        <h2>Reference</h2>
        <p class="subtitle">Architecture diagram and a glossary of the terms used across the dashboard.</p>
      </div>
      <div class="card-body overview-reference-body">
        <details class="overview-details">
          <summary>How it's wired <span class="overview-details-hint">— architecture diagram</span></summary>
          <div class="overview-arch">
            <svg viewBox="0 0 620 200" role="img" aria-labelledby="arch-title arch-desc" class="overview-arch-svg">
              <title id="arch-title">LlamaLync architecture</title>
              <desc id="arch-desc">People-X and Risk-X mock sources feed the LlamaLync middleware, which pushes user_account resources to Vanta's Build Integrations app and reads or writes native Vanta entities via the Manage Vanta app.</desc>
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280"/>
                </marker>
              </defs>
              <rect x="20" y="65" width="140" height="70" rx="8" fill="#f6f7f9" stroke="#dde1e7"/>
              <text x="90" y="100" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="#240642">People-X + Risk-X</text>
              <text x="90" y="118" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#6b7280">mock source systems</text>
              <rect x="230" y="65" width="160" height="70" rx="8" fill="#AC55FF" stroke="#240642"/>
              <text x="310" y="100" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="700" fill="#F8F4F3">LlamaLync</text>
              <text x="310" y="118" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#F8F4F3">middleware</text>
              <rect x="460" y="20" width="140" height="60" rx="8" fill="#f6f7f9" stroke="#dde1e7"/>
              <text x="530" y="45" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#240642">Vanta · Build</text>
              <text x="530" y="62" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#6b7280">push surface</text>
              <rect x="460" y="120" width="140" height="60" rx="8" fill="#f6f7f9" stroke="#dde1e7"/>
              <text x="530" y="145" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#240642">Vanta · Manage</text>
              <text x="530" y="162" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#6b7280">read + write surface</text>
              <g stroke="#6b7280" stroke-width="1.5" fill="none">
                <path d="M 160 100 L 225 100" marker-end="url(#arrow)"/>
                <path d="M 390 88 L 455 60" marker-end="url(#arrow)"/>
                <path d="M 455 145 L 390 112" marker-start="url(#arrow)" marker-end="url(#arrow)"/>
              </g>
              <text x="190" y="92" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#6b7280">poll</text>
              <text x="395" y="55" font-family="system-ui, sans-serif" font-size="10" fill="#6b7280">PUT user_account</text>
              <text x="345" y="147" font-family="system-ui, sans-serif" font-size="10" fill="#6b7280">GET compliance</text>
              <text x="345" y="159" font-family="system-ui, sans-serif" font-size="10" fill="#6b7280">POST risks</text>
            </svg>
          </div>
        </details>

        <details class="overview-details">
          <summary>Get the source <span class="overview-details-hint">— fork, clone, or deploy your own</span></summary>
          <div class="overview-source-block">
            <p>LlamaLync is open source under the MIT license. The reference repo is
            <a href="https://github.com/brianjlehnen/llamalync-demo" target="_blank" rel="noopener noreferrer">github.com/brianjlehnen/llamalync-demo</a>.</p>
            <p>Three ways to run your own instance against your Vanta tenant:</p>
            <ol>
              <li><strong>Deploy directly to Render</strong> — click the <em>Deploy to Render</em> button at the top of the README. Spins up a free-tier instance in ~2 minutes; you'll be prompted for the Vanta env vars during setup.</li>
              <li><strong>Fork the repo</strong> (top-right of the GitHub page), then deploy from your fork the same way — gives you a copy you can modify.</li>
              <li><strong>Clone locally</strong>: <code>git clone https://github.com/brianjlehnen/llamalync-demo.git</code>, then <code>npm install</code> + <code>npm start</code>. README has the full prerequisites and walkthrough.</li>
            </ol>
            <p>Setup requires creating two Vanta apps in your Developer Console (Build Integrations + Manage Vanta). The README walks through each step with links to Vanta's published quickstarts.</p>
          </div>
        </details>

        <details class="overview-details">
          <summary>Glossary <span class="overview-details-hint">— terms used across the dashboard</span></summary>
          <dl class="overview-glossary">
            <dt>Build app</dt>
            <dd>Vanta app type for pushing custom resources (<code>user_account</code>, <code>computer</code>, <code>vulnerability</code>) using <code>connectors.self:*</code> scopes. Rate-limited at 20 req/min per app.</dd>
            <dt>Manage app</dt>
            <dd>Vanta app type for reading Vanta-native entities (<code>controls</code>, <code>tests</code>, <code>people</code>, <code>vulnerabilities</code>) and writing native Risk scenarios using <code>vanta-api.all:*</code> scopes. Rate-limited at 50 req/min per app.</dd>
            <dt>Full-snapshot PUT</dt>
            <dd>The <code>user_account</code> endpoint replaces the entire resource set on every call. Records absent from the payload get soft-deleted with a <code>deletedAt</code> timestamp — sending an empty resources array soft-deletes everything.</dd>
            <dt><code>user_account</code> vs Person</dt>
            <dd>A <code>user_account</code> is identity/auth-shaped (login, MFA, permission level). A Person is HR-shaped (job title, department, employment status). LlamaLync pushes <code>user_account</code>; the Person side is read-only via Manage Vanta.</dd>
            <dt>Activity log</dt>
            <dd>In-memory ring buffer of the last 50 Vanta API calls, visible on Developer → API Activity. OAuth token requests are excluded so credentials never appear in the log.</dd>
          </dl>
        </details>
      </div>
    </section>
  </main>

  <main id="tab-personnel" class="tab-panel">
    ${renderDemoGuide(DEMO_GUIDE_PERSONNEL)}
    <section class="card source-card">
      <div class="card-header card-header-row">
        <div class="card-header-main">
          <div class="card-pill source"><span class="dot"></span>Source · pull</div>
          <h2>People-X (HRIS)</h2>
          <p class="subtitle">A simulated stand-in for a customer's bespoke system — i.e. internal HR app, CSV-to-S3 drop, REST API, SCIM endpoint. LlamaLync polls it on each sync.</p>
        </div>
        ${refreshStatusHtml}
      </div>
      <div class="card-body" id="source-body">
        ${renderSourceCard(source)}
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div class="card-pill build"><span class="dot"></span>Build Integrations · push</div>
        <h2>Pushed personnel</h2>
        <p class="subtitle">user_account records currently held in Vanta for this integration. Scope: <code>connectors.self:read-resource</code>. Rate-limit bucket: 20/min.</p>
      </div>
      <div class="card-body" id="personnel-body">
        ${renderPersonnelCard(personnel)}
      </div>
    </section>
  </main>

  <main id="tab-devices" class="tab-panel">
    ${renderDemoGuide(DEMO_GUIDE_DEVICES)}
    <section class="card source-card">
      <div class="card-header card-header-row">
        <div class="card-header-main">
          <div class="card-pill source"><span class="dot"></span>Source · pull</div>
          <h2>CMDB-X (homegrown asset inventory)</h2>
          <p class="subtitle">A simulated stand-in for a customer's bespoke CMDB / on-prem asset DB / on-prem MDM — ServiceNow CMDB module, internal asset web app, flat spreadsheet. LlamaLync polls it on each sync and resolves device owners against the People-X roster.</p>
        </div>
        ${refreshStatusHtml}
      </div>
      <div class="card-body" id="device-source-body">
        ${renderDeviceSourceCard(deviceSource, emailById)}
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div class="card-pill build"><span class="dot"></span>Build Integrations · push</div>
        <h2>Computers in Vanta (per platform)</h2>
        <p class="subtitle">Two separate JTD-schema resource types — <code>MacosUserComputer</code> and <code>WindowsUserComputer</code>. Same Build Integrations surface as Personnel; same 20 req/min bucket. Linux source rows are excluded (no native Vanta base type).</p>
      </div>
      <div class="card-body" id="device-pushed-body">
        ${renderPushedDevicesCard(devicePushed)}
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div class="card-pill build"><span class="dot"></span>Windows · richer schema</div>
        <h2>Windows Security Center signals</h2>
        <p class="subtitle">The Windows-only <code>windowsSecurityCenter</code> optional carries six independent enum-rated signals per device — materially richer than macOS's single <code>isXProtectEnabled</code> boolean. Color-coded GOOD / POOR / SNOOZED / NOT_MONITORED / ERROR.</p>
      </div>
      <div class="card-body" id="device-wsc-body">
        ${renderWindowsSecurityCenterCard(deviceSource)}
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div class="card-pill warn"><span class="dot"></span>Unsupported · visible-by-design</div>
        <h2>Linux (no native Vanta resource type)</h2>
        <p class="subtitle">Visible coverage boundary: Linux devices surfaced explicitly rather than silently filtered, so auditors see exactly which fleet members fall outside Vanta's native coverage. See <code>docs/scenarios/devices.md §5</code> for the Go/No-Go rationale.</p>
      </div>
      <div class="card-body" id="device-unsupported-body">
        ${renderUnsupportedLinuxCard(deviceSource, emailById)}
      </div>
    </section>
  </main>

  <main id="tab-evidence" class="tab-panel">
    ${renderDemoGuide(DEMO_GUIDE_EVIDENCE)}
    <section class="card source-card">
      <div class="card-header card-header-row">
        <div class="card-header-main">
          <div class="card-pill source"><span class="dot"></span>Source · pull</div>
          <h2>Evidence-X (compliance file store)</h2>
          <p class="subtitle">A simulated stand-in for a customer's local evidence-file repository — SharePoint, S3 bucket, GRC tool export, internal audit-evidence app. Each file is pre-bound in <code>mock-data/evidence/_manifest.json</code> to its target Vanta evidence-request slot.</p>
        </div>
        ${refreshStatusHtml}
      </div>
      <div class="card-body" id="evidence-source-body">
        ${renderEvidenceSourceCard(evidenceSource)}
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div class="card-pill build"><span class="dot"></span>Build Integrations · upload</div>
        <h2>Vanta evidence-request slots</h2>
        <p class="subtitle">The Phase 0 architectural finding: Vanta "Documents" are <strong>pre-defined evidence-request slots</strong>, not arbitrary uploads. Slot ids are slug-style (<code>access-requests</code>, <code>audit-cycle-documented</code>) and each carries its auditor-facing description. Upload via <code>POST /v1/documents/{slug}/uploads</code> with <code>self:write-document</code>.</p>
      </div>
      <div class="card-body" id="evidence-slots-body">
        ${renderEvidenceSlotsCard(evidenceSource, evidenceSlots)}
      </div>
    </section>
  </main>

  <main id="tab-events" class="tab-panel single-card">
    ${renderWebhooksTab(webhooks)}
  </main>

  <main id="tab-risk" class="tab-panel">
    ${renderDemoGuide(DEMO_GUIDE_RISK)}
    <section class="card source-card">
      <div class="card-header card-header-row">
        <div class="card-header-main">
          <div class="card-pill source"><span class="dot"></span>Source · pull</div>
          <h2>Risk-X (homegrown register)</h2>
          <p class="subtitle">A simulated stand-in for a customer's bespoke risk register — internal web app, Confluence page, Airtable, homegrown GRC tool. LlamaLync polls it on each sync.</p>
        </div>
        ${refreshStatusHtml}
      </div>
      <div class="card-body" id="risk-source-body">
        ${renderRiskSourceCard(riskSource)}
      </div>
    </section>

    <!-- Post-sync warnings banner. Populated by syncRiskNow() with the
         unknownOwnerEmails list from the /sync/risk response. Lives BETWEEN
         the cards so the softRefresh body-swap doesn't clear it. Hidden until
         a sync produces a warning; resets to hidden on the next sync if clean. -->
    <div id="risk-sync-warnings" class="callout callout-warn" hidden></div>

    <section class="card">
      <div class="card-header">
        <div class="card-pill manage"><span class="dot"></span>Manage Vanta · write</div>
        <h2>Risk scenarios in Vanta</h2>
        <p class="subtitle">Native Vanta risk-scenario records — different surface from Personnel (Manage Vanta, not Build Integrations). Scope: <code>vanta-api.all:read vanta-api.all:write</code>. Register: <code>${escapeHtml(process.env.VANTA_RISK_REGISTER || 'unset')}</code>.</p>
      </div>
      <div class="card-body" id="risk-pushed-body">
        ${renderPushedRiskCard(riskPushed)}
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div class="card-pill source"><span class="dot"></span>Risk-X · matrix view</div>
        <h2>Inherent → residual heatmap</h2>
        <p class="subtitle">Each filled dot is one or more open risks at their inherent (likelihood × impact) position. Arrows show how treatment moves them — hollow dots are the residual landing spots. Untreated risks have no arrow (residual = inherent).</p>
      </div>
      <div class="card-body" id="risk-matrix-body">
        ${renderRiskMatrixCard(riskSource)}
      </div>
    </section>
  </main>

  <main id="tab-compliance" class="tab-panel single-card">
    <section class="card">
      <div class="card-header">
        <div class="card-pill manage"><span class="dot"></span>Manage Vanta · read</div>
        <h2>Compliance state</h2>
        <p class="subtitle">Live read of Vanta's native entities — controls, tests, vulns, people. Tenant-wide; not driven by LlamaLync's pushes. Scopes on the Manage app: <code>vanta-api.all:read vanta-api.all:write</code> (this tab uses <code>:read</code>; <code>:write</code> is for the Risk scenario). Rate-limit bucket: 50/min.</p>
      </div>
      <div class="card-body" id="compliance-body">
        ${renderComplianceCard(compliance)}
      </div>
    </section>
  </main>

  <div id="tab-developer" class="tab-panel">
    <div class="sub-tabs">
      <button class="sub-tab active" data-subtab="activity" onclick="switchSubTab('activity')">API Activity</button>
      <button class="sub-tab"        data-subtab="explorer" onclick="switchSubTab('explorer')">API Explorer</button>
    </div>

  <div id="subtab-activity" class="subtab-panel active">
    <div class="activity-list">
      <div class="activity-toolbar">
        <span>Last <span id="activity-count">0</span> Vanta API calls — newest first. OAuth token requests excluded.</span>
        <button class="btn btn-secondary btn-sm" onclick="clearActivity()">Clear log</button>
      </div>
      <div id="activity-rows">
        <div class="activity-empty">No Vanta API calls yet. Try Hire, Offboard, or Sync Now from the Overview tab.</div>
      </div>
    </div>
  </div>

  <div id="subtab-explorer" class="subtab-panel">
    <div class="explorer">
      <div class="explorer-intro">
        Send live Vanta API requests through one of two apps:
        <ul>
          <li><strong>Build Integrations</strong> — push side, used by the Personnel tab</li>
          <li><strong>Manage Vanta</strong> — read + write, used by the Compliance tab for reads and the Risk tab for writes</li>
        </ul>
        Each call is also logged in the Activity tab.
      </div>

      <div class="explorer-import">
        <div class="explorer-import-controls">
          <label for="exp-import-file" class="btn btn-secondary btn-sm explorer-import-btn">
            Import Postman collection…
            <input type="file" id="exp-import-file" accept=".json,application/json" onchange="handlePostmanImport(this)" hidden>
          </label>
          <button type="button" id="exp-import-clear" class="btn btn-secondary btn-sm" onclick="clearImportedPresets()" hidden>Clear imported</button>
          <span id="exp-import-status" class="explorer-import-status muted"></span>
        </div>
      </div>

      <div class="explorer-presets">
        <label for="exp-preset" class="explorer-presets-label">Quick presets:</label>
        <select id="exp-preset" onchange="loadPreset(this)">
          <option value="">Choose a preset…</option>
          <optgroup label="Build Integrations · Read">
            <option value="build-pushed-users">List pushed user_accounts</option>
          </optgroup>
          <optgroup label="Build Integrations · Write (with body)">
            <option value="build-put-user-account">PUT user_account snapshot</option>
          </optgroup>
          <optgroup label="Manage Vanta · Lists">
            <option value="manage-people">List people</option>
            <option value="manage-tests">List tests</option>
            <option value="manage-controls">List controls</option>
            <option value="manage-vulns">List vulnerabilities</option>
            <option value="manage-vendors">List vendors</option>
            <option value="manage-integrations">List integrations</option>
            <option value="manage-frameworks">List frameworks</option>
            <option value="manage-policies">List policies</option>
            <option value="manage-documents">List documents</option>
            <option value="manage-risks">List risks</option>
          </optgroup>
          <optgroup label="Manage Vanta · Filtered">
            <option value="manage-tests-fail">Failing tests</option>
            <option value="manage-tests-pass">Passing tests</option>
            <option value="manage-people-overdue">People with overdue tasks</option>
            <option value="manage-people-active">Active employees</option>
            <option value="manage-people-terminated">Terminated employees</option>
            <option value="manage-vulns-open">Open vulnerabilities</option>
            <option value="manage-vulns-near-sla">Vulns approaching SLA (7 days)</option>
          </optgroup>
          <optgroup label="Manage Vanta · By ID (replace the placeholder)">
            <option value="manage-person-by-id">Person by id</option>
            <option value="manage-test-by-id">Test by id</option>
            <option value="manage-control-by-id">Control by id</option>
            <option value="manage-vuln-by-id">Vulnerability by id</option>
            <option value="manage-vendor-by-id">Vendor by id</option>
            <option value="manage-integration-by-id">Integration by id</option>
          </optgroup>
        </select>
      </div>

      <div class="explorer-form">
        <div class="explorer-row">
          <label>App
            <select id="exp-app" onchange="updateScopeWarning()">
              <option value="build">Build (push)</option>
              <option value="manage" selected>Manage (read/write)</option>
            </select>
          </label>
          <label>Method
            <select id="exp-method" onchange="updateScopeWarning()">
              <option value="GET" selected>GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
          </label>
          <label class="explorer-row-path">Path
            <input id="exp-path" type="text" placeholder="/v1/people?pageSize=10" autocomplete="off" spellcheck="false">
          </label>
        </div>

        <div id="exp-scope-warning" class="explorer-warning" hidden>
          <strong>Scope warning:</strong>
          <span id="exp-scope-warning-text"></span>
        </div>

        <div id="exp-preset-meta" class="explorer-preset-meta" hidden></div>

        <div id="exp-path-vars" class="explorer-vars" hidden>
          <div class="explorer-vars-label">Path variables <span class="muted">(required before send)</span></div>
          <div class="explorer-vars-rows" id="exp-path-vars-rows"></div>
        </div>

        <div id="exp-query-params" class="explorer-vars" hidden>
          <div class="explorer-vars-label">Query parameters <span class="muted">(uncheck to omit)</span></div>
          <div class="explorer-vars-rows" id="exp-query-params-rows"></div>
        </div>

        <div id="exp-headers" class="explorer-headers" hidden>
          <div class="explorer-vars-label">Headers <span class="muted">(read-only — Authorization &amp; Content-Type are set by LlamaLync)</span></div>
          <div id="exp-headers-rows"></div>
        </div>

        <div class="explorer-body-label-row">
          <label class="explorer-body-label" for="exp-body">
            Request body (JSON, optional — only used for POST/PUT/PATCH)
          </label>
          <div class="explorer-body-actions">
            <button type="button" class="btn btn-secondary btn-sm" onclick="prettyPrintBody()">Pretty-print</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="validateBody()">Validate JSON</button>
            <span id="exp-body-validate-status" class="explorer-validate-status"></span>
          </div>
        </div>
        <textarea id="exp-body" placeholder='{ "resourceId": "...", "resources": [...] }' rows="14" spellcheck="false"></textarea>

        <div class="explorer-actions">
          <button id="exp-send" class="btn btn-primary" onclick="explorerSend()">Send</button>
          <span id="exp-status" class="explorer-status"></span>
        </div>
      </div>

      <div id="exp-response" class="explorer-response">
        <div class="explorer-response-header">
          <span>Response</span>
          <span class="explorer-response-meta" id="exp-response-meta">— send a request to see the response —</span>
        </div>
        <pre class="activity-json" id="exp-response-body">No response yet. Pick a preset or fill in a path, then click Send.</pre>
      </div>
    </div>
  </div>
  </div>

  <div class="toast-container" id="toast-container"></div>

  <footer>
    <div class="footer-inner">
      <span>integration ${escapeHtml(buildIntegrationId)}</span>
      <span>resourceId ${escapeHtml(personnelResourceId)}</span>
      <span><a href="/dashboard.json">view raw JSON</a></span>
      <span><a href="https://github.com/brianjlehnen/llamalync-demo" target="_blank" rel="noopener noreferrer" title="View source on GitHub" class="github-link">
        <svg class="github-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 .5C5.6.5.5 5.6.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2.2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.5-.3-5.2-1.3-5.2-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2.9-.3 1.9-.4 2.9-.4s2 .1 2.9.4c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.7.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.2 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.6 18.4.5 12 .5z"/></svg>
        <span>source</span>
      </a></span>
      <span class="health-indicator" id="health-indicator" title="/health">
        <span class="dot health-dot"></span>
        <span class="health-label">healthy</span>
      </span>
      <div class="footer-tenant">${renderTenantRibbon()}</div>
    </div>
  </footer>

  <script>
    // Postman v2.1 parser — same source as test/postmanImport.test.js, inlined
    // here so the browser can call parsePostmanCollection() without a server
    // round-trip. Kept identical to disk; do not hand-edit this section.
    ${POSTMAN_IMPORT_JS}

    // Auto-refresh: re-fetch /dashboard.json on the data-refresh tick and
    // update the live numbers in place. Avoids full page reloads (jarring
    // on screenshare) while still showing live data movement during a demo.
    const HEARTBEAT_MS = ${HEARTBEAT_MS};
    const DATA_REFRESH_MS = ${DATA_REFRESH_MS};
    const ACTIVITY_REFRESH_MS = ${ACTIVITY_REFRESH_MS};
    const REFRESH_MS = HEARTBEAT_MS; // legacy alias kept for any downstream readers

    function fmtStamp(iso) {
      if (!iso) return '—';
      return iso.slice(11, 19) + ' UTC';
    }

    function setText(id, value) {
      const el = document.getElementById(id);
      if (el && value !== undefined && value !== null) el.textContent = value;
    }

    async function refresh() {
      try {
        const r = await fetch('/dashboard.json', { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        // meta-stamp is now class-based (one instance per source card); update all.
        const stampText = fmtStamp(d.generatedAt);
        if (stampText) {
          document.querySelectorAll('.meta-stamp').forEach(el => { el.textContent = stampText; });
        }
        const active = (d.personnel && d.personnel.active) ? d.personnel.active.length : 0;
        setText('hero-personnel', active);
        const s = d.source || {};
        setText('src-total',      s.total);
        setText('src-active',     s.activeEmployees);
        setText('src-terminated', s.terminated);
        setText('src-svc',        s.serviceAccounts);
        const c = d.compliance || {};
        setText('m-controls',      c.controls && c.controls.total);
        setText('m-failing-tests', c.tests && c.tests.failingCount);
        setText('m-vulns',         c.vulnerabilities && c.vulnerabilities.approachingSLACount);
        setText('m-people',        c.people && c.people.overdueTaskCount);

        // Pulse every live-dot instance (one per source card).
        document.querySelectorAll('.live-dot').forEach(dot => {
          dot.classList.remove('pulse');
          // Force reflow so the animation restarts
          void dot.offsetWidth;
          dot.classList.add('pulse');
        });
      } catch (e) {
        // Silent — better to show stale data than break the page mid-demo.
      }
    }

    // ─── Auto-refresh pause toggle ───────────────────────────────────────
    // SAs running a demo sometimes want to freeze the dashboard mid-screenshare
    // (e.g. on a specific number on the Overview tab while explaining what
    // it represents) without the 5-min data tick blowing it away. The toggle
    // suspends the data + activity ticks; heartbeat keeps running because
    // it's /health-only and no Vanta calls are involved. State persists in
    // sessionStorage so a soft-refresh doesn't unpause silently.
    const AUTO_REFRESH_KEY = 'llmly-auto-refresh-paused';
    let autoRefreshPaused = false;
    try { autoRefreshPaused = sessionStorage.getItem(AUTO_REFRESH_KEY) === '1'; } catch (e) { /* ignore */ }

    function syncAutoRefreshUi() {
      const btn = document.getElementById('auto-refresh-toggle');
      if (btn) {
        btn.textContent = autoRefreshPaused ? '▶' : '⏸';
        btn.title = autoRefreshPaused
          ? 'Auto-refresh paused — click to resume. Manual ↻ refresh still works.'
          : 'Pause auto-refresh (data tick every ' + (DATA_REFRESH_MS / 60000) + ' min). Heartbeat keeps running — it only hits /health, not Vanta.';
      }
      // Visually mark every live-dot as paused so the user can see the state
      // from anywhere on the page, not just near the toggle. The CSS rule
      // dims the dot and suppresses the pulse animation.
      document.querySelectorAll('.live-dot').forEach(dot => {
        dot.classList.toggle('paused', autoRefreshPaused);
      });
      // Append "(paused)" to every meta-stamp so SAs glancing at any source
      // card know the data underneath isn't ticking.
      document.querySelectorAll('.meta-stamp').forEach(el => {
        const base = el.dataset.stampBase || el.textContent.replace(/ \\(paused\\)$/, '');
        el.dataset.stampBase = base;
        el.textContent = autoRefreshPaused ? base + ' (paused)' : base;
      });
    }

    function toggleAutoRefresh() {
      autoRefreshPaused = !autoRefreshPaused;
      try { sessionStorage.setItem(AUTO_REFRESH_KEY, autoRefreshPaused ? '1' : '0'); } catch (e) { /* ignore */ }
      syncAutoRefreshUi();
      toast(
        autoRefreshPaused ? 'Auto-refresh paused' : 'Auto-refresh resumed',
        'info',
        autoRefreshPaused ? 'Data tick suspended · ↻ still works for manual refresh' : 'Data tick every ' + (DATA_REFRESH_MS / 60000) + ' min'
      );
    }

    // Sync UI once on load — handles both initial render and the case where
    // a user reloads while paused state is in sessionStorage.
    syncAutoRefreshUi();

    // Data refresh — slow tick (5 min), only when tab is visible AND not paused.
    // Idle background tabs make zero Vanta calls; paused state suppresses them
    // even when the tab is visible.
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (autoRefreshPaused) return;
      refresh();
    }, DATA_REFRESH_MS);

    // ─── Error → remediation hint ─────────────────────────────────────────
    // Maps Vanta-typical HTTP status codes (and the fetch-throws-on-network
    // path) to a one-line actionable hint appended to the toast detail. The
    // base error text from Vanta is preserved so the operator still sees
    // the exact field/scope/etc. that failed; the hint adds the "now what."
    //
    // status === 0 is the convention used by callers to mean "no HTTP
    // response — the fetch threw" (typically ECONNREFUSED / DNS / CORS).
    // We sniff the exception message for network-y wording before adding
    // the unreachable hint, so a non-network JS error (e.g. JSON parse)
    // passes through unchanged.
    function formatErrorDetail(status, errorText, fallback) {
      const baseText = errorText || fallback || (status ? 'Status ' + status : 'Unknown error');
      let hint = '';
      if (status === 401) {
        hint = 'OAuth token rejected — re-run npm run check:auth or rotate the VANTA_*_CLIENT_SECRET that matches this surface.';
      } else if (status === 403) {
        hint = 'Scope missing — verify Developer Console app scopes. Build needs connectors.self:{read,write}-resource (+ self:{read,write}-document for Evidence); Manage requests vanta-api.all:{read,write}.';
      } else if (status === 404) {
        hint = 'Not found — check VANTA_*_RESOURCE_ID values; a stale or mistyped id is the typical cause.';
      } else if (status === 422) {
        // Vanta's body usually says exactly which field is wrong (we surface
        // it verbatim above). Keep the hint tight — no scenario-specific
        // examples that read as noise when irrelevant to the current action.
        hint = 'Vanta rejected the payload as invalid. See the message above for the specific field.';
      } else if (status === 409) {
        hint = 'A sync is already in flight (manual click or scheduled tick). Wait for it to finish, then retry.';
      } else if (status === 429) {
        hint = 'Rate limited — wait a minute and retry. Build Integrations is 20 req/min; Manage Vanta is 50 req/min.';
      } else if (status === 0 || status === undefined || status === null) {
        const lower = String(errorText || '').toLowerCase();
        if (/failed to fetch|networkerror|econnrefused|networkerror when|load failed/.test(lower)) {
          hint = 'LlamaLync server unreachable — is it still running on this host? Check the terminal for crash output.';
        }
      } else if (status >= 500) {
        hint = 'Server-side error — usually transient. Retry in a moment; persists → check the Activity tab for the exact request body.';
      }
      return hint ? (baseText + ' · ' + hint) : baseText;
    }

    // ─── Toast notifications ──────────────────────────────────────────────

    function toast(message, type, detail) {
      type = type || 'info';
      const t = document.createElement('div');
      t.className = 'toast toast-' + type;
      t.innerHTML = '<strong>' + escapeHtmlClient(message) + '</strong>' +
        (detail ? '<span class="toast-detail">' + escapeHtmlClient(detail) + '</span>' : '');
      document.getElementById('toast-container').appendChild(t);
      // Force reflow so the transition runs
      void t.offsetWidth;
      t.classList.add('show');
      setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.remove(), 300);
      }, 3500);
    }

    // ─── Soft refresh: re-fetch the page, swap card body innerHTMLs ──────
    // No full reload, no white flash, scroll position preserved. Activity
    // tab loads independently when active.

    async function softRefresh() {
      try {
        const r = await fetch('/', { cache: 'no-store' });
        if (!r.ok) return;
        const html = await r.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        ['source-body', 'personnel-body', 'risk-source-body', 'risk-pushed-body', 'risk-matrix-body', 'device-source-body', 'device-pushed-body', 'device-wsc-body', 'device-unsupported-body', 'evidence-source-body', 'evidence-slots-body', 'compliance-body', 'webhook-events-body', 'workflowsink-body'].forEach(id => {
          const fresh = doc.getElementById(id);
          const current = document.getElementById(id);
          if (fresh && current) current.innerHTML = fresh.innerHTML;
        });
        // Update every source card's meta-stamp + pulse every live-dot. The
        // selectors are class-based (not id-based) because each source card
        // carries its own copy of the refresh affordance for visual
        // consistency across tabs.
        const freshStamps = doc.querySelectorAll('.meta-stamp');
        const freshStampText = freshStamps[0] && freshStamps[0].textContent;
        if (freshStampText) {
          document.querySelectorAll('.meta-stamp').forEach(el => { el.textContent = freshStampText; });
        }
        document.querySelectorAll('.live-dot').forEach(dot => {
          dot.classList.remove('pulse');
          void dot.offsetWidth;
          dot.classList.add('pulse');
        });
        // softRefresh swaps card bodies from server HTML, which carries no
        // "(paused)" suffix on meta-stamps and no .paused class on live-dots.
        // Re-apply the paused state so visual indicators stay consistent.
        syncAutoRefreshUi();
      } catch (e) { /* silent */ }
    }

    // ─── Action handlers ──────────────────────────────────────────────────
    // Disable the originating button during the request to prevent double-fire,
    // soft-refresh on success, toast feedback either way.

    async function withButtonLock(btn, fn) {
      const original = btn.textContent;
      btn.disabled = true;
      try {
        await fn();
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    }

    // ─── Confirm gating for tenant-touching actions ──────────────────────
    // Inline "click again to confirm" pattern. First click puts the button
    // into a warn-tinted confirm state with the label text changed to a
    // call-to-action. A second click within 5 seconds proceeds with the
    // action; no second click → button reverts to its original state
    // silently. Protects the four actions that actually write to Vanta
    // (Sync All × 3 surfaces + Upload Evidence) — accidental mid-demo
    // clicks no longer mutate tenant state.
    //
    // Composes with withButtonLock: withConfirm resets the button text
    // BEFORE invoking the action, so withButtonLock's textContent capture
    // inside the action body still sees the original label.
    function withConfirm(button, confirmLabel, action) {
      if (!button) return action();

      // Second click — already in confirm state; proceed with action.
      if (button.dataset.llmlyConfirming === '1') {
        const timerId = parseInt(button.dataset.llmlyConfirmTimer || '0', 10);
        if (timerId) clearTimeout(timerId);
        const original = button.dataset.llmlyConfirmOriginal || '';
        if (original) button.textContent = original;
        button.classList.remove('btn-confirming');
        delete button.dataset.llmlyConfirming;
        delete button.dataset.llmlyConfirmTimer;
        delete button.dataset.llmlyConfirmOriginal;
        return action();
      }

      // First click — enter confirm state. Capture original text so we can
      // restore it on timeout or on second-click proceed.
      button.dataset.llmlyConfirmOriginal = button.textContent;
      button.dataset.llmlyConfirming = '1';
      button.textContent = confirmLabel || '⚠ Click again to confirm';
      button.classList.add('btn-confirming');
      const timerId = setTimeout(() => {
        if (button.dataset.llmlyConfirming === '1') {
          button.textContent = button.dataset.llmlyConfirmOriginal || button.textContent;
          button.classList.remove('btn-confirming');
          delete button.dataset.llmlyConfirming;
          delete button.dataset.llmlyConfirmTimer;
          delete button.dataset.llmlyConfirmOriginal;
        }
      }, 5000);
      button.dataset.llmlyConfirmTimer = String(timerId);
      // No promise to return — action fires on the user's second click,
      // not on this initial invocation.
    }

    async function hire(event) {
      const btn = (event && event.currentTarget) || null;
      const action = async () => {
        try {
          const r = await fetch('/mock-peoplex/employees', { method: 'POST' });
          if (!r.ok) { toast('Hire failed', 'error', formatErrorDetail(r.status)); return; }
          const emp = await r.json();
          await softRefresh();
          toast('Hired ' + emp.firstName + ' ' + emp.lastName, 'info', 'Source updated · click Sync Now to push to Vanta');
        } catch (e) {
          toast('Hire failed', 'error', formatErrorDetail(0, e.message));
        }
      };
      if (btn) await withButtonLock(btn, action); else await action();
    }

    async function offboard(id, event) {
      const btn = (event && event.currentTarget) || null;
      const action = async () => {
        try {
          const r = await fetch('/mock-peoplex/employees/' + encodeURIComponent(id) + '/offboard', { method: 'POST' });
          if (!r.ok) { toast('Offboard failed', 'error', formatErrorDetail(r.status)); return; }
          await softRefresh();
          toast('Offboarded ' + id, 'info', 'Marked terminated · next sync will soft-delete in Vanta');
        } catch (e) {
          toast('Offboard failed', 'error', formatErrorDetail(0, e.message));
        }
      };
      if (btn) await withButtonLock(btn, action); else await action();
    }

    async function syncNow() {
      const btn = document.getElementById('sync-btn');
      return withConfirm(btn, '⚠ Click again to push to Vanta', async () => {
        const original = btn.textContent;
        btn.textContent = 'Syncing…';
        btn.disabled = true;
        const t0 = Date.now();
        try {
          const r = await fetch('/sync/personnel', { method: 'POST' });
          const result = await r.json().catch(() => ({}));
          const ms = Date.now() - t0;
          if (r.status === 409) {
            toast('Personnel sync already running', 'info', formatErrorDetail(r.status, result.error));
            return;
          }
          if (!r.ok) {
            toast('Sync failed', 'error', formatErrorDetail(r.status, result.error));
            return;
          }
          const stats = result.stats || {};
          const skipped = stats.skipped || {};
          await softRefresh();
          toast(
            'Synced ' + (stats.pushed || 0) + ' record' + ((stats.pushed === 1) ? '' : 's') + ' to Vanta',
            'success',
            ms + 'ms · ' + (skipped.terminated || 0) + ' terminated, ' + (skipped.serviceAccounts || 0) + ' service accounts filtered'
          );
        } catch (e) {
          toast('Sync failed', 'error', formatErrorDetail(0, e.message));
        } finally {
          btn.textContent = original;
          btn.disabled = false;
        }
      });
    }

    async function resetMutations() {
      try {
        const r = await fetch('/mock-peoplex/reset', { method: 'POST' });
        if (!r.ok) { toast('Reset failed', 'error', formatErrorDetail(r.status)); return; }
        await softRefresh();
        toast('Source reset to baseline', 'info');
      } catch (e) {
        toast('Reset failed', 'error', formatErrorDetail(0, e.message));
      }
    }

    // ─── Webhook demo replay ──────────────────────────────────────────────
    async function triggerWebhookReplay(dedupeTest) {
      const primary = document.getElementById('webhook-replay-btn');
      const dedupe  = document.getElementById('webhook-replay-dedupe-btn');
      const btn     = dedupeTest ? dedupe : primary;
      if (!btn) return;
      const originalText = btn.textContent;
      btn.textContent = dedupeTest ? 'Replaying…' : 'Triggering…';
      [primary, dedupe].forEach(b => { if (b) b.disabled = true; });
      try {
        const url = '/demo/webhook/replay' + (dedupeTest ? '?dedupeTest=true' : '');
        const r = await fetch(url, { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          toast('Demo event failed', 'error', formatErrorDetail(r.status, body.error));
          return;
        }
        await softRefresh();
        const detail = dedupeTest
          ? (body.deduped ? 'Replayed svix-id ' + body.svixId + ' — receiver deduped, no new Workflow Sink payload' : 'Replay sent but was not deduped')
          : 'Synthesized ' + body.eventType + ' · forwarded to Workflow Sink';
        toast(dedupeTest ? 'Dedupe test sent' : 'Demo event triggered', 'success', detail);
      } catch (e) {
        toast('Demo event failed', 'error', formatErrorDetail(0, e.message));
      } finally {
        btn.textContent = originalText;
        [primary, dedupe].forEach(b => { if (b) b.disabled = false; });
      }
    }

    // ─── Demo-reset handlers ──────────────────────────────────────────────
    // "Reset demo state" — full-snapshot empty PUT to Vanta where possible,
    // then a local mock reset. Wrapped in withConfirm because this writes
    // to Vanta. Used between demos to restore baseline on the same sandbox
    // tenant; without it, every demo accretes records and drift gets noisy.
    async function resetDemoPersonnel(event) {
      const btn = (event && event.currentTarget) || null;
      return withConfirm(btn, '⚠ Click again to clear Vanta records', async () => {
        if (!btn) return;
        const original = btn.textContent;
        btn.textContent = 'Resetting…';
        btn.disabled = true;
        try {
          const r = await fetch('/demo/reset/personnel', { method: 'POST' });
          const result = await r.json().catch(() => ({}));
          if (!r.ok) {
            toast('Reset failed', 'error', formatErrorDetail(r.status, result.error));
            return;
          }
          await softRefresh();
          toast('Personnel demo reset', 'success', 'Vanta records cleared (empty PUT) · People-X back to baseline');
        } catch (e) {
          toast('Reset failed', 'error', formatErrorDetail(0, e.message));
        } finally {
          btn.textContent = original;
          btn.disabled = false;
        }
      });
    }

    // ─── Risk tab action handlers (slice 5.2) ────────────────────────────
    // All four follow the same pattern as their Personnel counterparts:
    //   - Hit the mock-riskx endpoint (source-side) or /sync/risk (Vanta-side)
    //   - softRefresh() on success
    //   - Toast feedback either way
    //   - withButtonLock() to prevent double-fire on row buttons

    async function addRisk(event) {
      const btn = (event && event.currentTarget) || null;
      const action = async () => {
        try {
          const r = await fetch('/mock-riskx/risks', { method: 'POST' });
          if (!r.ok) { toast('Add risk failed', 'error', formatErrorDetail(r.status)); return; }
          const risk = await r.json();
          await softRefresh();
          toast('Added ' + risk.internalId, 'info', 'Source updated · click Sync All to push to Vanta');
        } catch (e) {
          toast('Add risk failed', 'error', formatErrorDetail(0, e.message));
        }
      };
      if (btn) await withButtonLock(btn, action); else await action();
    }

    async function applyTreatment(id, event) {
      const btn = (event && event.currentTarget) || null;
      const action = async () => {
        try {
          const r = await fetch('/mock-riskx/risks/' + encodeURIComponent(id) + '/apply-treatment', { method: 'POST' });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast('Apply treatment failed', 'error', formatErrorDetail(r.status, err.error));
            return;
          }
          await softRefresh();
          toast('Applied treatment to ' + id, 'info', 'Residual scoring set in Risk-X · next Sync All updates Vanta');
        } catch (e) {
          toast('Apply treatment failed', 'error', formatErrorDetail(0, e.message));
        }
      };
      if (btn) await withButtonLock(btn, action); else await action();
    }

    async function closeRisk(id, event) {
      const btn = (event && event.currentTarget) || null;
      const action = async () => {
        try {
          const r = await fetch('/mock-riskx/risks/' + encodeURIComponent(id) + '/close', { method: 'POST' });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast('Close failed', 'error', formatErrorDetail(r.status, err.error));
            return;
          }
          await softRefresh();
          toast('Closed ' + id + ' in Risk-X', 'info', 'Source-side state · next Sync All mirrors to Source Status customField');
        } catch (e) {
          toast('Close failed', 'error', formatErrorDetail(0, e.message));
        }
      };
      if (btn) await withButtonLock(btn, action); else await action();
    }

    async function syncRiskNow() {
      const btn = document.getElementById('risk-sync-btn');
      if (!btn) return;
      return withConfirm(btn, '⚠ Click again to push risks to Vanta', async () => {
        const original = btn.textContent;
        btn.textContent = 'Syncing…';
        btn.disabled = true;
        const t0 = Date.now();
        try {
          const r = await fetch('/sync/risk', { method: 'POST' });
          const result = await r.json().catch(() => ({}));
          const ms = Date.now() - t0;
          if (!r.ok) {
            toast('Risk sync failed', 'error', formatErrorDetail(r.status, result.error));
            return;
          }
          const stats = result.stats || {};
          await softRefresh();
          renderRiskSyncWarnings(stats.unknownOwnerEmails);

          const created = stats.created || 0;
          const updated = stats.updated || 0;
          const stale   = stats.staleInVanta || 0;
          const errors  = stats.errors || 0;
          const tone = errors > 0 ? 'error' : 'success';
          toast(
            'Sync complete: ' + created + ' created, ' + updated + ' updated',
            tone,
            ms + 'ms · ' + stale + ' stale in Vanta · ' + errors + ' error' + (errors === 1 ? '' : 's')
          );
        } catch (e) {
          toast('Risk sync failed', 'error', formatErrorDetail(0, e.message));
        } finally {
          btn.textContent = original;
          btn.disabled = false;
        }
      });
    }

    async function resetRiskMutations() {
      try {
        const r = await fetch('/mock-riskx/reset', { method: 'POST' });
        if (!r.ok) { toast('Reset failed', 'error', formatErrorDetail(r.status)); return; }
        await softRefresh();
        // Clear any lingering sync warning — register baseline is restored.
        renderRiskSyncWarnings(null);
        toast('Risk-X reset to baseline', 'info');
      } catch (e) {
        toast('Reset failed', 'error', formatErrorDetail(0, e.message));
      }
    }

    // Risk has no public DELETE endpoint, so the Vanta-side cleanup is manual.
    // We reset Risk-X locally and surface a clear hint pointing the user at
    // the Vanta UI for any scenarios LlamaLync pushed.
    async function resetDemoRisk(event) {
      const btn = (event && event.currentTarget) || null;
      return withConfirm(btn, '⚠ Click again to reset Risk-X', async () => {
        if (!btn) return;
        const original = btn.textContent;
        btn.textContent = 'Resetting…';
        btn.disabled = true;
        try {
          const r = await fetch('/demo/reset/risk', { method: 'POST' });
          const result = await r.json().catch(() => ({}));
          if (!r.ok) {
            toast('Reset failed', 'error', formatErrorDetail(r.status, result.error));
            return;
          }
          await softRefresh();
          renderRiskSyncWarnings(null);
          toast(
            'Risk-X reset · Vanta cleanup is manual',
            'info',
            result.manualCleanupHint || 'Open Vanta UI → Risk Management and archive any demo-pushed scenarios.'
          );
        } catch (e) {
          toast('Reset failed', 'error', formatErrorDetail(0, e.message));
        } finally {
          btn.textContent = original;
          btn.disabled = false;
        }
      });
    }

    // ─── Devices tab action handlers ─────────────────────────────────────
    // Same pattern as Personnel + Risk: mutate source-side via /mock-cmdbx,
    // softRefresh, toast feedback. The sync action hits /sync/devices which
    // PUTs both platforms (macOS + Windows) and reports per-platform stats.

    async function onboardDevice(event) {
      const btn = (event && event.currentTarget) || null;
      const action = async () => {
        try {
          const r = await fetch('/mock-cmdbx/devices', { method: 'POST' });
          if (!r.ok) { toast('Onboard failed', 'error', formatErrorDetail(r.status)); return; }
          const dev = await r.json();
          await softRefresh();
          const osHint = dev.os === 'Linux'
            ? ' · Linux device — will surface in the Unsupported panel, NOT pushed'
            : ' · click Sync All to push to Vanta';
          toast('Onboarded ' + dev.id + ' (' + dev.os + ')', 'info', 'Source updated' + osHint);
        } catch (e) {
          toast('Onboard failed', 'error', formatErrorDetail(0, e.message));
        }
      };
      if (btn) await withButtonLock(btn, action); else await action();
    }

    async function decommissionDevice(id, event) {
      const btn = (event && event.currentTarget) || null;
      const action = async () => {
        try {
          const r = await fetch('/mock-cmdbx/devices/' + encodeURIComponent(id) + '/decommission', { method: 'POST' });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast('Decommission failed', 'error', formatErrorDetail(r.status, err.error));
            return;
          }
          await softRefresh();
          toast('Decommissioned ' + id, 'info', 'Source-side state · next Sync All drops it from the platform PUT; Vanta soft-deletes via full-snapshot');
        } catch (e) {
          toast('Decommission failed', 'error', formatErrorDetail(0, e.message));
        }
      };
      if (btn) await withButtonLock(btn, action); else await action();
    }

    async function reassignOwner(id, event) {
      const btn = (event && event.currentTarget) || null;
      // Prompt the operator for the new owner. Empty string / "null" / cancel
      // all reassign to null (explicitly orphan the device). The mock-cmdbx
      // reassign endpoint accepts null verbatim.
      const raw = window.prompt(
        'Reassign ' + id + ' — enter the new assignedEmployeeId (e.g. emp-001), or leave blank to orphan it.',
        ''
      );
      if (raw === null) return; // user cancelled
      const trimmed = raw.trim();
      const newAssignedEmployeeId = (trimmed === '' || trimmed.toLowerCase() === 'null') ? null : trimmed;

      const action = async () => {
        try {
          const r = await fetch('/mock-cmdbx/devices/' + encodeURIComponent(id) + '/reassign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assignedEmployeeId: newAssignedEmployeeId })
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            toast('Reassign failed', 'error', formatErrorDetail(r.status, err.error));
            return;
          }
          await softRefresh();
          const detail = newAssignedEmployeeId
            ? 'New owner: ' + newAssignedEmployeeId + ' · next Sync All updates Vanta'
            : 'Device explicitly orphaned · next Sync All pushes owner: null';
          toast('Reassigned ' + id, 'info', detail);
        } catch (e) {
          toast('Reassign failed', 'error', formatErrorDetail(0, e.message));
        }
      };
      if (btn) await withButtonLock(btn, action); else await action();
    }

    async function syncDevicesNow() {
      const btn = document.getElementById('device-sync-btn');
      if (!btn) return;
      return withConfirm(btn, '⚠ Click again to push devices to Vanta', async () => {
        const original = btn.textContent;
        btn.textContent = 'Syncing…';
        btn.disabled = true;
        const t0 = Date.now();
        try {
          const r = await fetch('/sync/devices', { method: 'POST' });
          const result = await r.json().catch(() => ({}));
          const ms = Date.now() - t0;
          if (r.status === 409) {
            toast('Device sync already running', 'info', formatErrorDetail(r.status, result.error));
            return;
          }
          if (!r.ok) {
            toast('Device sync failed', 'error', formatErrorDetail(r.status, result.error));
            return;
          }
          const stats = result.stats || {};
          const pushed = stats.pushed || {};
          const skipped = stats.skipped || {};
          const orphans = stats.orphans || {};
          await softRefresh();
          toast(
            'Synced ' + ((pushed.macos || 0) + (pushed.windows || 0)) + ' device' + ((pushed.macos + pushed.windows) === 1 ? '' : 's'),
            'success',
            ms + 'ms · ' + (pushed.macos || 0) + ' macOS + ' + (pushed.windows || 0) + ' Windows · ' +
              (skipped.linuxUnsupported || 0) + ' Linux excluded · ' +
              ((orphans.macos || 0) + (orphans.windows || 0)) + ' orphan'
          );
        } catch (e) {
          toast('Device sync failed', 'error', formatErrorDetail(0, e.message));
        } finally {
          btn.textContent = original;
          btn.disabled = false;
        }
      });
    }

    async function resetCmdbMutations() {
      try {
        const r = await fetch('/mock-cmdbx/reset', { method: 'POST' });
        if (!r.ok) { toast('Reset failed', 'error', formatErrorDetail(r.status)); return; }
        await softRefresh();
        toast('CMDB-X reset to baseline', 'info');
      } catch (e) {
        toast('Reset failed', 'error', formatErrorDetail(0, e.message));
      }
    }

    async function resetDemoDevices(event) {
      const btn = (event && event.currentTarget) || null;
      return withConfirm(btn, '⚠ Click again to clear Vanta devices', async () => {
        if (!btn) return;
        const original = btn.textContent;
        btn.textContent = 'Resetting…';
        btn.disabled = true;
        try {
          const r = await fetch('/demo/reset/devices', { method: 'POST' });
          const result = await r.json().catch(() => ({}));
          if (!r.ok) {
            toast('Reset failed', 'error', formatErrorDetail(r.status, result.error));
            return;
          }
          await softRefresh();
          if (r.status === 207 && result.partial) {
            toast(
              'Devices reset — partial Vanta clear',
              'info',
              result.manualCleanupHint || 'CMDB-X mutations reset locally; re-click Reset to retry the failed platform.'
            );
            return;
          }
          toast('Devices demo reset', 'success', 'macOS + Windows snapshots cleared · CMDB-X back to baseline');
        } catch (e) {
          toast('Reset failed', 'error', formatErrorDetail(0, e.message));
        } finally {
          btn.textContent = original;
          btn.disabled = false;
        }
      });
    }

    // ─── Evidence tab action handlers ────────────────────────────────────
    // Single-file upload primitive — hits /sync/evidence with the filename
    // as the body. Server reads the file via mockEvidenceStore, builds the
    // multipart POST to /v1/documents/{slot}/uploads, and records the
    // upload in session history so the row re-renders with "✓ uploaded"
    // and a "view in Vanta" link after softRefresh.

    async function uploadEvidence(filename, event) {
      const btn = (event && event.currentTarget) || null;
      const action = async () => {
        const t0 = Date.now();
        try {
          const r = await fetch('/sync/evidence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
          });
          const result = await r.json().catch(() => ({}));
          const ms = Date.now() - t0;
          if (!r.ok) {
            toast('Upload failed', 'error', formatErrorDetail(r.status, result.error));
            return;
          }
          const stats = result.stats || {};
          await softRefresh();
          const slotHint = stats.targetSlot
            ? ' → /v1/documents/' + stats.targetSlot + '/uploads'
            : '';
          toast(
            'Uploaded ' + filename,
            'success',
            ms + 'ms · ' + (stats.byteLength || 0) + ' bytes' + slotHint
          );
        } catch (e) {
          toast('Upload failed', 'error', formatErrorDetail(0, e.message));
        }
      };
      if (btn) {
        return withConfirm(btn, '⚠ Click again to upload', async () => {
          await withButtonLock(btn, action);
        });
      }
      await action();
    }

    async function resetEvidenceMutations() {
      try {
        const r = await fetch('/mock-evidencex/reset', { method: 'POST' });
        if (!r.ok) { toast('Reset failed', 'error', formatErrorDetail(r.status)); return; }
        await softRefresh();
        toast('Evidence session history cleared', 'info', 'Previously-uploaded files in Vanta are unchanged (no UNDO via the API)');
      } catch (e) {
        toast('Reset failed', 'error', formatErrorDetail(0, e.message));
      }
    }

    async function resetDemoEvidence(event) {
      const btn = (event && event.currentTarget) || null;
      return withConfirm(btn, '⚠ Click again to reset Evidence-X', async () => {
        if (!btn) return;
        const original = btn.textContent;
        btn.textContent = 'Resetting…';
        btn.disabled = true;
        try {
          const r = await fetch('/demo/reset/evidence', { method: 'POST' });
          const result = await r.json().catch(() => ({}));
          if (!r.ok) {
            toast('Reset failed', 'error', formatErrorDetail(r.status, result.error));
            return;
          }
          await softRefresh();
          toast(
            'Evidence-X reset · Vanta cleanup is manual',
            'info',
            result.manualCleanupHint || 'Open Vanta UI → Compliance → Documents to remove demo-uploaded files.'
          );
        } catch (e) {
          toast('Reset failed', 'error', formatErrorDetail(0, e.message));
        } finally {
          btn.textContent = original;
          btn.disabled = false;
        }
      });
    }

    // Populates the inline banner with unknown-owner emails from the last
    // sync. Hidden when the list is empty/missing; non-persistent across
    // page reloads (lives in DOM only, not in any backend cache).
    function renderRiskSyncWarnings(unknownOwnerEmails) {
      const banner = document.getElementById('risk-sync-warnings');
      if (!banner) return;
      if (!Array.isArray(unknownOwnerEmails) || unknownOwnerEmails.length === 0) {
        banner.hidden = true;
        banner.innerHTML = '';
        return;
      }
      const items = unknownOwnerEmails
        .map(e => '<code>' + escapeHtmlClient(e) + '</code>')
        .join(', ');
      banner.innerHTML =
        '<strong>Last sync · ' + unknownOwnerEmails.length +
        ' owner email' + (unknownOwnerEmails.length === 1 ? '' : 's') +
        ' not resolved to a Vanta user:</strong> ' + items +
        ' <span class="muted">— those risks synced with no owner attached. ' +
        'Add the user in Vanta or update the Risk-X owner to clear.</span> ' +
        '· <a href="#" onclick="renderRiskSyncWarnings(null); return false;">Dismiss</a>';
      banner.hidden = false;
    }

    // ─── Tabs (Overview / Personnel / Compliance / Developer) ────────────

    const VALID_TABS = ['overview', 'personnel', 'devices', 'evidence', 'events', 'risk', 'compliance', 'developer'];
    const TAB_STORAGE_KEY = 'llamalync.dashboard.lastTab';

    function switchTab(name) {
      if (!VALID_TABS.includes(name)) return; // Defensive — ignore unknown tabs
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === name);
      });
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === 'tab-' + name);
      });
      // Persist so a returning visitor lands where they left off. Wrapped in
      // try/catch because some browsers block localStorage in private mode.
      try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch (e) { /* ignore */ }
      // When entering Developer, refresh whichever sub-tab is active
      if (name === 'developer') {
        const sub = document.querySelector('.sub-tab.active')?.dataset.subtab || 'activity';
        if (sub === 'activity') loadActivity();
      }
    }

    // Restore the last-visited tab on page load. New visitors fall through
    // to the server-rendered default (Overview), so a script failure or a
    // private-browsing block leaves the page in a sensible state.
    function restoreLastTab() {
      try {
        const stored = localStorage.getItem(TAB_STORAGE_KEY);
        if (stored && VALID_TABS.includes(stored) && stored !== 'overview') {
          switchTab(stored);
        }
      } catch (e) { /* ignore */ }
    }

    function switchSubTab(name) {
      document.querySelectorAll('.sub-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.subtab === name);
      });
      document.querySelectorAll('.subtab-panel').forEach(p => {
        p.classList.toggle('active', p.id === 'subtab-' + name);
      });
      if (name === 'activity') loadActivity();
    }

    function escapeHtmlClient(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Lightweight JSON syntax highlighter — wraps tokens in spans by class.
    function syntaxHighlight(value) {
      if (value === null || value === undefined) return '<span class="json-null">null</span>';
      // Plain string body (e.g., CloudFront HTML error page, plain-text response).
      // JSON-stringifying it produces a single quoted line with literal \\n —
      // unreadable. Render as escaped plain text instead so newlines survive.
      if (typeof value === 'string') {
        return escapeHtmlClient(value);
      }
      // Truncated body envelope from vantaClient.truncateBody — preview is a
      // string that already represents the (sliced) body. Render the preview
      // as plain text + a small note instead of JSON-stringifying the wrapper.
      if (value && typeof value === 'object' && value._truncated === true && typeof value.preview === 'string') {
        const note = '<span class="json-null">// truncated · ' + value._totalChars + ' total chars · showing first ' + value.preview.length + '</span>\\n';
        return note + escapeHtmlClient(value.preview);
      }
      const json = JSON.stringify(value, null, 2);
      const escaped = escapeHtmlClient(json);
      return escaped.replace(
        /("(\\\\.|[^"\\\\])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+\\-]?\\d+)?)/g,
        (match) => {
          let cls = 'json-number';
          if (/^"/.test(match)) {
            cls = /:$/.test(match) ? 'json-key' : 'json-string';
          } else if (/true|false/.test(match)) {
            cls = 'json-boolean';
          } else if (/null/.test(match)) {
            cls = 'json-null';
          }
          return '<span class="' + cls + '">' + match + '</span>';
        }
      );
    }

    function statusClass(status) {
      if (status >= 200 && status < 300) return 's2xx';
      if (status >= 400 && status < 500) return 's4xx';
      if (status >= 500 || status === 0) return 's5xx';
      return '';
    }

    function fmtClock(iso) {
      if (!iso) return '—';
      // HH:MM:SS in UTC
      return iso.slice(11, 19);
    }

    // Track activity row IDs we've already rendered, so when loadActivity
    // re-runs (after a sync) we can flash the new rows.
    const seenActivityIds = new Set();

    function renderActivityRow(entry, isFresh) {
      const hasReq = entry.requestBody !== null && entry.requestBody !== undefined;
      const hasResp = entry.responseBody !== null && entry.responseBody !== undefined;
      const errSection = entry.error
        ? '<div class="activity-section"><div class="activity-section-label">error</div><div class="activity-error">' + escapeHtmlClient(entry.error) + '</div></div>'
        : '';
      const reqSection = hasReq
        ? '<div class="activity-section"><div class="activity-section-label">request body</div><pre class="activity-json">' + syntaxHighlight(entry.requestBody) + '</pre></div>'
        : '';
      const respSection = hasResp
        ? '<div class="activity-section"><div class="activity-section-label">response body</div><pre class="activity-json">' + syntaxHighlight(entry.responseBody) + '</pre></div>'
        : '';
      const attemptNote = entry.attempt > 1 ? ' (attempt ' + entry.attempt + ')' : '';
      return (
        '<div class="activity-row' + (isFresh ? ' fresh' : '') + '" onclick="this.classList.toggle(\\'expanded\\')">' +
          '<div class="activity-row-header">' +
            '<span class="activity-time">' + fmtClock(entry.timestamp) + '</span>' +
            '<span class="activity-app ' + entry.app + '">' + entry.app + '</span>' +
            '<span class="activity-method-path"><span class="activity-method">' + entry.method + '</span>' + escapeHtmlClient(entry.path) + attemptNote + '</span>' +
            '<span class="activity-status ' + statusClass(entry.status) + '">' + (entry.status || 'ERR') + '</span>' +
            '<span class="activity-duration">' + (entry.durationMs != null ? entry.durationMs + 'ms' : '—') + '</span>' +
            '<span class="activity-chevron">▶</span>' +
          '</div>' +
          '<div class="activity-body">' +
            errSection + reqSection + respSection +
          '</div>' +
        '</div>'
      );
    }

    async function loadActivity() {
      try {
        const r = await fetch('/requests.json', { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        const rows = d.requests || [];
        document.getElementById('activity-count').textContent = rows.length;
        const container = document.getElementById('activity-rows');
        if (rows.length === 0) {
          container.innerHTML = '<div class="activity-empty">No Vanta API calls yet. Try Hire, Offboard, or Sync Now from the Overview tab.</div>';
          seenActivityIds.clear();
        } else {
          // First load primes the seen set without flashing everything as fresh.
          const isFirstLoad = seenActivityIds.size === 0;
          container.innerHTML = rows.map(entry => {
            const fresh = !isFirstLoad && !seenActivityIds.has(entry.id);
            return renderActivityRow(entry, fresh);
          }).join('');
          rows.forEach(entry => seenActivityIds.add(entry.id));
        }
      } catch (e) {
        // silent
      }
    }

    async function clearActivity() {
      await fetch('/requests/clear', { method: 'POST' });
      seenActivityIds.clear();
      loadActivity();
    }

    // Activity sub-tab refresh — 30s, only when tab is visible AND user is on the activity sub-tab.
    // Honors the same pause toggle as the data tick — SAs pausing mid-demo
    // don't want the activity log scrolling underneath their cursor either.
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (autoRefreshPaused) return;
      const activeTab = document.querySelector('.tab.active')?.dataset.tab;
      const activeSub = document.querySelector('.sub-tab.active')?.dataset.subtab;
      if (activeTab === 'developer' && activeSub === 'activity') loadActivity();
    }, ACTIVITY_REFRESH_MS);

    // ─── API Explorer tab ─────────────────────────────────────────────────

    // Preset paths customer engineers most commonly want to see during a call.
    // Server-rendered VANTA_PERSONNEL_RESOURCE_ID and Vanta tomorrow's deadline
    // for SLA filter are baked in below. Path-template presets use {placeholder}
    // syntax that the user replaces in the path field before sending.
    const PERSONNEL_RID = ${JSON.stringify(personnelResourceId)};
    const SLA_DEADLINE_ISO = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    // ─── Imported Postman presets (localStorage-backed) ───────────────────
    // Imported presets coexist with the built-in EXPLORER_PRESETS. Built-ins
    // never go away — that means a bad import or a cleared localStorage still
    // leaves a working Explorer. Imported presets render as a separate optgroup
    // at the top of the preset dropdown.
    const IMPORTED_STORAGE_KEY = 'llamalync.explorer.imported';
    let IMPORTED_PRESETS_BY_ID = {};
    let currentImportedPreset = null; // Tracks the active imported preset for send-time substitution

    function loadImportedFromStorage() {
      try {
        const raw = localStorage.getItem(IMPORTED_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.presets)) return null;
        return parsed;
      } catch (e) {
        return null;
      }
    }

    function saveImportedToStorage(payload) {
      try {
        localStorage.setItem(IMPORTED_STORAGE_KEY, JSON.stringify(payload));
        return true;
      } catch (e) {
        return false;
      }
    }

    function renderImportedDropdown(payload) {
      const select = document.getElementById('exp-preset');
      const clearBtn = document.getElementById('exp-import-clear');
      const status = document.getElementById('exp-import-status');

      // Wipe any previously-rendered imported optgroups. We tag them with
      // data-imported="true" so this only touches imports — the built-in
      // optgroups in the static markup are left alone.
      select.querySelectorAll('optgroup[data-imported="true"]').forEach(g => g.remove());
      IMPORTED_PRESETS_BY_ID = {};

      if (!payload || !payload.presets || payload.presets.length === 0) {
        clearBtn.hidden = true;
        return;
      }

      // Group presets by their Postman folder path, preserving the order they
      // first appear in the collection. A single Postman collection can have
      // 100+ requests across dozens of folders; flattening everything into one
      // optgroup makes the dropdown unscannable. Splitting by folder mirrors
      // how the user organised their collection in Postman.
      const groupOrder = [];
      const byGroup = {};
      for (const p of payload.presets) {
        IMPORTED_PRESETS_BY_ID[p.id] = p;
        const g = p.group || '(ungrouped)';
        if (!byGroup[g]) {
          byGroup[g] = [];
          groupOrder.push(g);
        }
        byGroup[g].push(p);
      }

      // Insert imported optgroups before the first built-in optgroup so they
      // sit at the top of the dropdown without disturbing the built-ins.
      const firstBuiltIn = select.querySelector('optgroup:not([data-imported="true"])');

      for (const groupPath of groupOrder) {
        const og = document.createElement('optgroup');
        og.dataset.imported = 'true';
        og.label = 'Imported · ' + groupPath;
        for (const p of byGroup[groupPath]) {
          const opt = document.createElement('option');
          opt.value = 'imported:' + p.id;
          // Group is now in the optgroup label, so option text is just
          // METHOD + name — much shorter and easier to scan.
          opt.textContent = (p.method || 'GET') + ' ' + p.name;
          og.appendChild(opt);
        }
        if (firstBuiltIn) {
          select.insertBefore(og, firstBuiltIn);
        } else {
          select.appendChild(og);
        }
      }

      clearBtn.hidden = false;

      const collectionName = payload.collectionName || 'Postman collection';
      const skipNote = payload.skipped && payload.skipped.length
        ? ' (' + payload.skipped.length + ' skipped: formdata/file/oauth)'
        : '';
      status.textContent = payload.presets.length + ' imported from ' + collectionName
        + ' across ' + groupOrder.length + ' folders' + skipNote;
      status.classList.remove('error');
      status.classList.add('ok');
    }

    function handlePostmanImport(fileInput) {
      const file = fileInput.files && fileInput.files[0];
      const status = document.getElementById('exp-import-status');
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        const text = ev.target.result;
        let parsedJson;
        try {
          parsedJson = JSON.parse(text);
        } catch (e) {
          status.textContent = 'Import failed — invalid JSON: ' + e.message;
          status.classList.add('error');
          status.classList.remove('ok');
          fileInput.value = '';
          return;
        }
        const result = parsePostmanCollection(parsedJson);
        if (result.error) {
          status.textContent = 'Import failed — ' + result.error;
          status.classList.add('error');
          status.classList.remove('ok');
          fileInput.value = '';
          return;
        }
        const collectionName = (parsedJson && parsedJson.info && parsedJson.info.name) || file.name.replace(/\.postman_collection\.json$/i, '');
        const payload = {
          collectionName: collectionName,
          presets: result.presets,
          skipped: result.skipped,
          importedAt: new Date().toISOString()
        };
        if (!saveImportedToStorage(payload)) {
          status.textContent = 'Import failed — could not save to localStorage (quota?)';
          status.classList.add('error');
          status.classList.remove('ok');
          fileInput.value = '';
          return;
        }
        renderImportedDropdown(payload);
        fileInput.value = ''; // allow re-importing the same file
      };
      reader.onerror = function() {
        status.textContent = 'Import failed — could not read file';
        status.classList.add('error');
        status.classList.remove('ok');
      };
      reader.readAsText(file);
    }

    function clearImportedPresets() {
      try { localStorage.removeItem(IMPORTED_STORAGE_KEY); } catch (e) { /* ignore */ }
      IMPORTED_PRESETS_BY_ID = {};
      currentImportedPreset = null;
      renderImportedDropdown(null);
      const status = document.getElementById('exp-import-status');
      status.textContent = 'Imported presets cleared';
      status.classList.remove('error');
      status.classList.add('ok');
      // Reset any populated rows in case a previously-imported preset was active
      hidePresetMeta();
      hidePathVars();
      hideQueryParams();
      hideHeaders();
    }

    // ─── Preset row rendering helpers ─────────────────────────────────────

    function hidePresetMeta() {
      const el = document.getElementById('exp-preset-meta');
      el.hidden = true;
      el.textContent = '';
    }
    function showPresetMeta(preset) {
      const el = document.getElementById('exp-preset-meta');
      el.textContent = preset.group ? (preset.group + ' / ' + preset.name) : preset.name;
      el.hidden = false;
    }

    function hidePathVars() {
      document.getElementById('exp-path-vars').hidden = true;
      document.getElementById('exp-path-vars-rows').innerHTML = '';
    }
    function populatePathVars(pathVars) {
      const wrap = document.getElementById('exp-path-vars');
      const rows = document.getElementById('exp-path-vars-rows');
      rows.innerHTML = '';
      if (!pathVars || pathVars.length === 0) {
        wrap.hidden = true;
        return;
      }
      for (const v of pathVars) {
        const row = document.createElement('div');
        row.className = 'explorer-var-row';
        const keyEl = document.createElement('span');
        keyEl.className = 'var-key required';
        keyEl.textContent = v.key;
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.varKey = v.key;
        input.value = v.defaultValue || '';
        input.placeholder = v.description || v.key;
        input.spellcheck = false;
        const spacer = document.createElement('span');
        row.appendChild(keyEl);
        row.appendChild(input);
        row.appendChild(spacer);
        rows.appendChild(row);
      }
      wrap.hidden = false;
    }

    function hideQueryParams() {
      document.getElementById('exp-query-params').hidden = true;
      document.getElementById('exp-query-params-rows').innerHTML = '';
    }
    function populateQueryParams(queryParams) {
      const wrap = document.getElementById('exp-query-params');
      const rows = document.getElementById('exp-query-params-rows');
      rows.innerHTML = '';
      if (!queryParams || queryParams.length === 0) {
        wrap.hidden = true;
        return;
      }
      for (const q of queryParams) {
        const row = document.createElement('div');
        row.className = 'explorer-var-row';
        const keyEl = document.createElement('span');
        keyEl.className = 'var-key';
        keyEl.textContent = q.key;
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.queryKey = q.key;
        input.value = q.defaultValue || '';
        input.placeholder = q.description || q.key;
        input.spellcheck = false;
        const cb = document.createElement('label');
        cb.className = 'var-checkbox';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.queryEnabled = q.key;
        box.checked = !!q.enabledByDefault;
        cb.appendChild(box);
        cb.appendChild(document.createTextNode('send'));
        row.appendChild(keyEl);
        row.appendChild(input);
        row.appendChild(cb);
        rows.appendChild(row);
      }
      wrap.hidden = false;
    }

    function hideHeaders() {
      document.getElementById('exp-headers').hidden = true;
      document.getElementById('exp-headers-rows').innerHTML = '';
    }
    function populateHeaders(headers) {
      const wrap = document.getElementById('exp-headers');
      const rows = document.getElementById('exp-headers-rows');
      rows.innerHTML = '';
      if (!headers || headers.length === 0) {
        wrap.hidden = true;
        return;
      }
      for (const h of headers) {
        const row = document.createElement('div');
        row.className = 'header-row';
        const k = document.createElement('span');
        k.className = 'header-key';
        k.textContent = h.key + ':';
        const v = document.createElement('span');
        v.textContent = h.value;
        row.appendChild(k);
        row.appendChild(v);
        rows.appendChild(row);
      }
      wrap.hidden = false;
    }

    // ─── Body editor: pretty-print + validate ─────────────────────────────

    function prettyPrintBody() {
      const ta = document.getElementById('exp-body');
      const status = document.getElementById('exp-body-validate-status');
      const text = ta.value.trim();
      if (!text) {
        status.textContent = '';
        return;
      }
      try {
        ta.value = JSON.stringify(JSON.parse(text), null, 2);
        status.textContent = 'Pretty-printed';
        status.classList.remove('error');
        status.classList.add('ok');
      } catch (e) {
        status.textContent = 'Cannot pretty-print: ' + e.message;
        status.classList.add('error');
        status.classList.remove('ok');
      }
    }

    function validateBody() {
      const ta = document.getElementById('exp-body');
      const status = document.getElementById('exp-body-validate-status');
      const text = ta.value.trim();
      if (!text) {
        status.textContent = 'Empty (no body)';
        status.classList.remove('error', 'ok');
        return;
      }
      try {
        JSON.parse(text);
        status.textContent = 'Valid JSON';
        status.classList.remove('error');
        status.classList.add('ok');
      } catch (e) {
        status.textContent = 'Invalid: ' + e.message;
        status.classList.add('error');
        status.classList.remove('ok');
      }
    }

    const EXPLORER_PRESETS = {
      // Build Integrations · Read
      'build-pushed-users': {
        app: 'build', method: 'GET',
        path: '/v1/resources/user_account?resourceId=' + PERSONNEL_RID
      },
      // Build Integrations · Write
      'build-put-user-account': {
        app: 'build', method: 'PUT',
        path: '/v1/resources/user_account',
        body: {
          resourceId: PERSONNEL_RID,
          resources: [{
            uniqueId: 'demo-1',
            email: 'demo@peoplex.example.com',
            displayName: 'Demo User',
            fullName: 'Demo User',
            accountName: 'demo',
            externalUrl: 'https://peoplex.example.com/hr/employees/demo-1',
            permissionLevel: 'BASE',
            mfaEnabled: false,
            mfaMethods: [],
            status: 'ACTIVE',
            authMethod: 'PASSWORD',
            createdTimestamp: '2024-01-01T00:00:00.000Z',
            lastLoginTimestamp: new Date().toISOString()
          }]
        }
      },
      // Manage Vanta · Lists
      'manage-people':       { app: 'manage', method: 'GET', path: '/v1/people?pageSize=10' },
      'manage-tests':        { app: 'manage', method: 'GET', path: '/v1/tests?pageSize=10' },
      'manage-controls':     { app: 'manage', method: 'GET', path: '/v1/controls?pageSize=10' },
      'manage-vulns':        { app: 'manage', method: 'GET', path: '/v1/vulnerabilities?pageSize=10' },
      'manage-vendors':      { app: 'manage', method: 'GET', path: '/v1/vendors?pageSize=10' },
      'manage-integrations': { app: 'manage', method: 'GET', path: '/v1/integrations?pageSize=10' },
      'manage-frameworks':   { app: 'manage', method: 'GET', path: '/v1/frameworks?pageSize=10' },
      'manage-policies':     { app: 'manage', method: 'GET', path: '/v1/policies?pageSize=10' },
      'manage-documents':    { app: 'manage', method: 'GET', path: '/v1/documents?pageSize=10' },
      'manage-risks':        { app: 'manage', method: 'GET', path: '/v1/risk-scenarios?pageSize=10' },
      // Manage Vanta · Filtered
      'manage-tests-fail':       { app: 'manage', method: 'GET', path: '/v1/tests?outcome=FAIL&pageSize=10' },
      'manage-tests-pass':       { app: 'manage', method: 'GET', path: '/v1/tests?outcome=PASS&pageSize=10' },
      'manage-people-overdue':   { app: 'manage', method: 'GET', path: '/v1/people?hasOverdueSecurityTasks=true&pageSize=10' },
      'manage-people-active':    { app: 'manage', method: 'GET', path: '/v1/people?employmentStatus=ACTIVE&pageSize=10' },
      'manage-people-terminated':{ app: 'manage', method: 'GET', path: '/v1/people?employmentStatus=TERMINATED&pageSize=10' },
      'manage-vulns-open':       { app: 'manage', method: 'GET', path: '/v1/vulnerabilities?status=OPEN&pageSize=10' },
      'manage-vulns-near-sla':   { app: 'manage', method: 'GET', path: '/v1/vulnerabilities?status=OPEN&remediationDeadlineBefore=' + SLA_DEADLINE_ISO + '&pageSize=10' },
      // Manage Vanta · By ID
      'manage-person-by-id':      { app: 'manage', method: 'GET', path: '/v1/people/{personId}' },
      'manage-test-by-id':        { app: 'manage', method: 'GET', path: '/v1/tests/{testId}' },
      'manage-control-by-id':     { app: 'manage', method: 'GET', path: '/v1/controls/{controlId}' },
      'manage-vuln-by-id':        { app: 'manage', method: 'GET', path: '/v1/vulnerabilities/{vulnId}' },
      'manage-vendor-by-id':      { app: 'manage', method: 'GET', path: '/v1/vendors/{vendorId}' },
      'manage-integration-by-id': { app: 'manage', method: 'GET', path: '/v1/integrations/{integrationId}' }
    };

    function loadPreset(select) {
      const key = select.value;
      if (!key) return;

      // Imported preset path — comes through as "imported:<id>".
      if (key.indexOf('imported:') === 0) {
        const id = key.slice('imported:'.length);
        const preset = IMPORTED_PRESETS_BY_ID[id];
        if (!preset) {
          select.value = '';
          return;
        }
        currentImportedPreset = preset;
        // App may be null when the collection's top-level folder didn't match
        // Build/Manage. Default to manage so the user can switch it explicitly.
        document.getElementById('exp-app').value = preset.app || 'manage';
        document.getElementById('exp-method').value = preset.method || 'GET';
        document.getElementById('exp-path').value = preset.pathTemplate || '';
        document.getElementById('exp-body').value = preset.body && preset.body.template
          ? preset.body.template
          : '';
        showPresetMeta(preset);
        populatePathVars(preset.pathVars);
        populateQueryParams(preset.queryParams);
        populateHeaders(preset.headers);
        updateScopeWarning();
        select.value = '';
        return;
      }

      // Built-in preset path — unchanged behavior.
      const preset = EXPLORER_PRESETS[key];
      if (!preset) return;
      currentImportedPreset = null;
      document.getElementById('exp-app').value = preset.app;
      document.getElementById('exp-method').value = preset.method;
      document.getElementById('exp-path').value = preset.path;
      document.getElementById('exp-body').value = preset.body
        ? JSON.stringify(preset.body, null, 2)
        : '';
      hidePresetMeta();
      hidePathVars();
      hideQueryParams();
      hideHeaders();
      updateScopeWarning();
      select.value = '';
    }

    // Build the final request path by substituting path variables and
    // appending enabled query parameters. Returns { path, error } where
    // error is set if any variable is unsubstituted or required-but-empty.
    function buildExplorerPath(rawPath) {
      let path = rawPath;

      // Substitute path-var inputs (only present for imported presets).
      const varInputs = document.querySelectorAll('#exp-path-vars-rows input[data-var-key]');
      for (const input of varInputs) {
        const key = input.dataset.varKey;
        const value = input.value.trim();
        if (!value) continue; // Empty inputs are caught by the leftover-var check below
        const enc = encodeURIComponent(value);
        // Replace all three syntaxes Postman uses for path vars
        path = path.split(':' + key).join(enc);
        path = path.split('{' + key + '}').join(enc);
        path = path.split('{{' + key + '}}').join(enc);
      }

      // Catch any unsubstituted variable token. This fires for both imported
      // presets where the user left a required field empty and for built-in
      // presets where the user forgot to find-and-replace a placeholder.
      const leftover = path.match(/(:[a-zA-Z_][a-zA-Z0-9_]*|\{\{?[a-zA-Z_][a-zA-Z0-9_]*\}?\})/);
      if (leftover) {
        // Mark the matching input as invalid for visual feedback
        const offendingKey = leftover[0].replace(/^:/, '').replace(/^\{\{?/, '').replace(/\}?\}$/, '');
        const offendingInput = document.querySelector('#exp-path-vars-rows input[data-var-key="' + offendingKey + '"]');
        if (offendingInput) offendingInput.classList.add('invalid');
        return { path: null, error: 'Path still contains unsubstituted variable: ' + leftover[0] };
      }

      // Append enabled, non-empty query params from the structured rows.
      const queryRows = document.querySelectorAll('#exp-query-params-rows .explorer-var-row');
      const pairs = [];
      for (const row of queryRows) {
        const valueInput = row.querySelector('input[data-query-key]');
        const enabled = row.querySelector('input[data-query-enabled]');
        if (!valueInput || !enabled || !enabled.checked) continue;
        const v = valueInput.value.trim();
        if (!v) continue;
        pairs.push(encodeURIComponent(valueInput.dataset.queryKey) + '=' + encodeURIComponent(v));
      }
      if (pairs.length) {
        path += (path.indexOf('?') === -1 ? '?' : '&') + pairs.join('&');
      }

      return { path: path, error: null };
    }

    // Scope-warning slot. Post-Risk-scenario rollout, both apps hold full
    // read+write on their respective surface (Build: connectors.self:* |
    // Manage: vanta-api.all:*), so there is no within-app scope mismatch
    // left to flag here. Kept as a no-op hook so future cross-surface
    // warnings (e.g. "this path looks like the wrong app's surface") can
    // attach without rewiring the onchange handlers.
    function updateScopeWarning() {
      const banner = document.getElementById('exp-scope-warning');
      banner.hidden = true;
    }

    async function explorerSend() {
      const app = document.getElementById('exp-app').value;
      const method = document.getElementById('exp-method').value;
      const rawPath = document.getElementById('exp-path').value.trim();
      const bodyText = document.getElementById('exp-body').value.trim();
      const statusEl = document.getElementById('exp-status');
      const sendBtn = document.getElementById('exp-send');

      // Reset any prior invalid markers on path-var inputs before re-validation
      document.querySelectorAll('#exp-path-vars-rows input.invalid').forEach(el => el.classList.remove('invalid'));

      if (!rawPath) {
        statusEl.textContent = 'Path is required';
        statusEl.classList.add('error');
        return;
      }

      const built = buildExplorerPath(rawPath);
      if (built.error) {
        statusEl.textContent = built.error;
        statusEl.classList.add('error');
        return;
      }
      const path = built.path;

      let body = null;
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch (e) {
          statusEl.textContent = 'Body is not valid JSON: ' + e.message;
          statusEl.classList.add('error');
          return;
        }
      }

      statusEl.textContent = '';
      statusEl.classList.remove('error');
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';

      try {
        const r = await fetch('/api/explorer/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: app, method: method, path: path, body: body })
        });
        const result = await r.json();
        renderExplorerResponse(result);
      } catch (e) {
        statusEl.textContent = 'Network error: ' + e.message;
        statusEl.classList.add('error');
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
      }
    }

    function renderExplorerResponse(result) {
      const respEl = document.getElementById('exp-response');
      const metaEl = document.getElementById('exp-response-meta');
      const bodyEl = document.getElementById('exp-response-body');

      const status = result.status || 0;
      let cls = 's5xx';
      if (status >= 200 && status < 300) cls = 's2xx';
      else if (status >= 400 && status < 500) cls = 's4xx';

      const statusLabel = status === 0 ? 'ERR' : status;
      metaEl.innerHTML = '<span class="status ' + cls + '">' + statusLabel + '</span>'
        + ' · ' + (result.durationMs || 0) + 'ms';

      bodyEl.innerHTML = syntaxHighlight(result.body !== undefined ? result.body : { error: result.error });
      respEl.hidden = false;

      // Refresh activity tab silently — the new request just got logged
      seenActivityIds.size === 0 ? null : null; // no-op, just keep the set logic intact
    }

    // ─── Health heartbeat ─────────────────────────────────────────────────
    // Pings /health every 30s, pulses the footer dot on success, turns it
    // amber/red on stale or unreachable. Replaces the static "health" link
    // so customers don't accidentally navigate away from the dashboard.
    async function heartbeat() {
      const el = document.getElementById('health-indicator');
      if (!el) return;
      const label = el.querySelector('.health-label');
      try {
        const r = await fetch('/health', { cache: 'no-store' });
        const stamp = new Date().toISOString().slice(11, 19);
        if (r.ok) {
          el.classList.remove('stale', 'down');
          el.classList.remove('pulse');
          void el.offsetWidth; // restart animation
          el.classList.add('pulse');
          if (label) label.textContent = 'healthy';
          el.title = '/health · 200 · checked ' + stamp + ' UTC';
        } else {
          el.classList.remove('pulse', 'down');
          el.classList.add('stale');
          if (label) label.textContent = 'stale';
          el.title = '/health · ' + r.status + ' · checked ' + stamp + ' UTC';
        }
      } catch (e) {
        el.classList.remove('pulse', 'stale');
        el.classList.add('down');
        if (label) label.textContent = 'down';
        el.title = '/health · network error';
      }
    }
    // Heartbeat — keeps running regardless of tab visibility because /health is
    // free (no Vanta calls) and the visible "alive" signal is the point.
    heartbeat();
    setInterval(heartbeat, HEARTBEAT_MS);

    // Restore any previously-imported Postman presets so a returning user
    // doesn't have to re-import on every page load. Falls back silently
    // (built-in presets are always available) when localStorage is empty.
    renderImportedDropdown(loadImportedFromStorage());

    // Restore the last-visited tab. Server renders Overview as active, so
    // this only fires when a returning user had previously navigated away.
    restoreLastTab();
  </script>
</body>
</html>`;
}

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const data = await getDashboardData();
    res.type('html').send(renderDashboard(data));
  } catch (err) {
    logger.error('Dashboard render failed', { error: err.message });
    next(err);
  }
});

router.get('/dashboard.json', async (req, res, next) => {
  try {
    const data = await getDashboardData();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/requests.json', (req, res) => {
  res.json({ requests: getRequestLog() });
});

router.post('/requests/clear', express.json(), (req, res) => {
  clearRequestLog();
  res.json({ ok: true });
});

// Explorer — send an arbitrary Vanta API request and return the response.
// Auth-gated by the global session middleware; CSRF-checked in production.
// Whitelists app, method, and path prefix to keep the surface narrow.
router.post('/api/explorer/send', express.json({ limit: '64kb' }), async (req, res) => {
  const { app: appName, method, path, body } = req.body || {};

  if (appName !== 'build' && appName !== 'manage') {
    return res.status(400).json({ error: 'Invalid app: must be "build" or "manage"' });
  }
  const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  if (!validMethods.includes(method)) {
    return res.status(400).json({ error: 'Invalid method' });
  }
  if (typeof path !== 'string' || !path.startsWith('/v1/')) {
    return res.status(400).json({ error: 'Path must start with /v1/' });
  }
  // The prefix check above is necessary but not sufficient — `/v1/../foo`
  // passes it and then the URL resolver escapes the prefix once joined
  // to the base URL. Reject path-traversal patterns explicitly.
  if (explorerPathHasTraversal(path)) {
    return res.status(400).json({ error: 'Path traversal segments are not allowed' });
  }

  const client = appName === 'build' ? buildClient : manageClient;
  const startTime = Date.now();
  try {
    const data = await client.request(method, path, body || null);
    res.json({
      ok: true,
      status: 200,
      durationMs: Date.now() - startTime,
      body: data
    });
  } catch (err) {
    res.json({
      ok: false,
      status: err.response?.status || 0,
      durationMs: Date.now() - startTime,
      body: err.response?.data || null,
      error: err.message
    });
  }
});

module.exports = router;
// Pure helpers exposed for direct unit testing. The router itself stays
// the primary export; these are attached so tests don't need a render
// harness to verify HTML-escape / scheme-validation behavior.
module.exports.safeHref = safeHref;
module.exports.escapeHtml = escapeHtml;
module.exports.explorerPathHasTraversal = explorerPathHasTraversal;
