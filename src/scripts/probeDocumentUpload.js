/**
 * Surgical probe of Vanta's document-upload surface.
 *
 * Background: the GAP 3 plan originally pointed at `POST /v1/documents/upload`
 * and described Build Integrations scopes as "runtime-requested at token
 * time" — the reviewer corrected both. Current Vanta docs show the upload
 * path as `POST /v1/documents/{documentId}/uploads` (i.e. the upload targets
 * an existing document/evidence ID); and for Build Integrations, scopes are
 * selected at APP CREATION in the Developer Console — not at token-request
 * time. (Manage Vanta is the surface where scopes are token-time selected.)
 *
 * Open questions (from the approved GAP 3 plan, post-amendment):
 *
 *   Q1  Does the Build Integrations app already have `self:write-document`
 *       enabled at app creation? Or does the user need to enable it in
 *       Dev Console first?
 *   Q2  Which surface owns the upload — Build Integrations
 *       (`self:write-document`) or Manage Vanta
 *       (`vanta-api.documents:upload`)? Both? Different paths per scope?
 *   Q3  Is the correct path `POST /v1/documents/{documentId}/uploads`?
 *       Confirm that `POST /v1/documents/upload` (the original plan path)
 *       returns 404/405.
 *   Q4  What's the multipart field name for the file payload? (`file`,
 *       `document`, `evidence`, ...)
 *   Q5  Required metadata fields beyond the file itself? Iterate over
 *       `description`, `effectiveAtDate`, and combinations before falling
 *       back to field-name variants — a file-only 400 could mean either a
 *       wrong field name OR missing metadata, and the implementation needs
 *       to know which.
 *   Q6  Response shape — does it return a separate uploadId for later
 *       reference, or just echo the documentId?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Setup before running this probe
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. Pre-create a Document (or "evidence" record) in Vanta UI that this
 *    probe is allowed to attach files to. Capture its id; set as:
 *
 *      VANTA_PROBE_DOCUMENT_ID=<id>
 *
 *    If a documentId is not required, the probe will surface that empirically
 *    (one of the probes attempts the upload against a deliberately invalid
 *    id and reads the error shape).
 *
 * 2. ⚠ Developer Console step BEFORE running:
 *
 *    Open Vanta Developer Console → LlamaLync Sync (Build Integrations app)
 *    → Scopes/Permissions. Confirm `self:write-document` and
 *    `self:read-document` are both enabled. If they aren't, enable them in
 *    Dev Console FIRST. (Build Integrations scopes are app-creation-time, not
 *    token-time, so the code change in buildAuth.scope only takes effect once
 *    the Dev Console-side toggle is on.)
 *
 *    This probe will detect a missing scope by attempting a standalone
 *    OAuth token request that includes `self:write-document`. If the token
 *    issues with the scope, the Dev Console toggle is on; if the OAuth call
 *    rejects the scope, you need to enable it in Dev Console first.
 *
 *    The probe does NOT modify src/auth/authManager.js — that change is
 *    deliberately deferred until Phase 3 implementation, per amendment.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this probe will write to your tenant
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Multiple small placeholder text files (a few hundred bytes each) attached
 * to the document identified by VANTA_PROBE_DOCUMENT_ID. Each successful
 * probe attaches one file with a DISTINCT filename suffix
 * (`...-build-fileonly.txt`, `...-build-with-desc.txt`,
 *  `...-build-with-date.txt`, `...-build-with-both.txt`,
 *  `...-manage.txt`, `...-fieldvar-{name}.txt`), so the Vanta Documents UI
 * shows one row per probe call rather than several copies of the same file.
 * File content reads "LlamaLync API probe — safe to delete." Clean up via
 * Vanta UI (Documents tab) after the probe completes.
 *
 * ⚠ Token revocation note. This probe issues STANDALONE OAuth token requests
 * for both the Build Integrations and Manage Vanta apps (so it can request
 * scope strings that differ from what `buildAuth` / `manageAuth` cache in
 * src/auth/authManager.js). Vanta enforces one active token per app, so
 * each standalone request revokes the in-process singleton's cached token.
 * If the LlamaLync dashboard server (`npm start`) is running while you
 * execute this probe, expect one auto-recovering 401 in the dashboard's
 * logs after each token request — the vantaClient invalidates and refreshes
 * on the first 401 (see src/http/vantaClient.js:118-122). No user-visible
 * failure; just a transient log line. Stop the dashboard server first if
 * you want a clean log.
 *
 * Run: `node src/scripts/probeDocumentUpload.js`
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const axios = require('axios');

const TOKEN_URL = 'https://api.vanta.com/oauth/token';
const BASE_URL  = 'https://api.vanta.com';

// ─── Helpers ────────────────────────────────────────────────────────────────

function timestampSuffix() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hm = now.toTimeString().slice(0, 5).replace(':', '');
  return `${ymd}-${hm}`;
}

function shortJson(value, max = 1500) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return s && s.length > max ? s.slice(0, max) + '\n... [truncated]' : s;
}

async function probe(label, fn) {
  console.log('');
  console.log('═══ ' + label + ' ═══');
  try {
    const result = await fn();
    console.log('OK · response body:');
    console.log(shortJson(result));
    return { ok: true, result };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.log(`ERROR · status=${status}`);
    console.log('body:');
    console.log(shortJson(body));
    return { ok: false, status, body, message: err.message };
  }
}

/**
 * Issue a standalone OAuth token request with an arbitrary scope string —
 * deliberately bypasses the singleton authManager so probes can request a
 * scope set that's different from the one buildAuth/manageAuth currently
 * hold, without polluting the singleton's cache.
 */
async function getTokenStandalone({ clientId, clientSecret, scope, label }) {
  console.log('');
  console.log(`─── Acquiring ${label} token with scope: "${scope}"`);
  try {
    const resp = await axios.post(TOKEN_URL, {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
    console.log(`    OK — token expires in ${resp.data.expires_in}s`);
    return { ok: true, token: resp.data.access_token };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.log(`    ERROR — status=${status}`);
    console.log('    body:', shortJson(body, 500));
    return { ok: false, status, body, message: err.message };
  }
}

/**
 * Build a multipart/form-data body as a Buffer. Avoids the form-data npm
 * package — Phase 0 should not introduce new dependencies. Mirrors the
 * shape axios would produce: one part per field, file part carries
 * Content-Type and filename.
 */
function buildMultipartBody(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.filename) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
        `Content-Type: ${p.contentType || 'application/octet-stream'}\r\n\r\n`
      ));
      chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"\r\n\r\n` +
        `${p.value}`
      ));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function multipartUpload({ token, fullPath, parts, label }) {
  const boundary = '----LlamaLyncProbe' + Math.random().toString(36).slice(2, 12);
  const body = buildMultipartBody(boundary, parts);
  return probe(label, async () => {
    const resp = await axios.post(`${BASE_URL}${fullPath}`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length)
      },
      timeout: 15000,
      // axios decompresses JSON automatically; multipart responses are
      // small so we don't need streaming.
      maxBodyLength: Infinity
    });
    return resp.data;
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const documentId = process.env.VANTA_PROBE_DOCUMENT_ID;
  if (!documentId) {
    console.error('VANTA_PROBE_DOCUMENT_ID must be set in .env before running this probe.');
    console.error('Pre-create a Document in Vanta UI and use its id (the probe attaches a');
    console.error('placeholder text file to it). The probe also tests a deliberately invalid');
    console.error('id to capture the error shape — that does not require setup.');
    process.exit(1);
  }

  const stamp = timestampSuffix();
  // Today's ISO date for the effectiveAtDate metadata probe. Vanta's evidence
  // model commonly carries an "effective as of" timestamp — typically ISO-8601
  // date or date-time. Using date-only form since "effective date" semantics
  // are usually day-grained.
  const isoToday = new Date().toISOString().slice(0, 10);
  // Filename helper — each probe attaches a file with a distinct suffix so
  // multiple successful probes don't collide in the Vanta UI as copies of the
  // same filename.
  const fileForProbe = (suffix) => `llamalync-probe-${stamp}-${suffix}.txt`;
  const probeFileContent = Buffer.from(
    `LlamaLync API probe (${stamp}) — safe to delete.\n` +
    `Generated by src/scripts/probeDocumentUpload.js to verify Vanta document-upload semantics.\n`
  );

  console.log('Probe run · timestamp:    ', stamp);
  console.log('Target documentId:        ', documentId);
  console.log('Probe filename pattern:   ', `llamalync-probe-${stamp}-{suffix}.txt`);
  console.log('Probe file size (bytes):  ', probeFileContent.length);
  console.log('effectiveAtDate probe val:', isoToday);

  // ── Pre-flight: token acquisitions ──────────────────────────────────────
  console.log('');
  console.log('████████████████████████████████████████████████████████████');
  console.log('█ Pre-flight token acquisition');
  console.log('████████████████████████████████████████████████████████████');

  const buildToken = await getTokenStandalone({
    clientId: process.env.VANTA_BUILD_CLIENT_ID,
    clientSecret: process.env.VANTA_BUILD_CLIENT_SECRET,
    // Request the existing scopes + the new self:write-document. If the
    // Build Integrations app does NOT have self:write-document enabled in
    // Dev Console, this OAuth call should fail.
    scope: 'connectors.self:read-resource connectors.self:write-resource self:write-document self:read-document',
    label: 'Build Integrations (with self:write-document)'
  });

  const manageToken = await getTokenStandalone({
    clientId: process.env.VANTA_MANAGE_CLIENT_ID,
    clientSecret: process.env.VANTA_MANAGE_CLIENT_SECRET,
    // Try the documents-specific Manage Vanta scope alongside the existing ones.
    scope: 'vanta-api.all:read vanta-api.all:write vanta-api.documents:upload',
    label: 'Manage Vanta (with vanta-api.documents:upload)'
  });

  if (!buildToken.ok && !manageToken.ok) {
    console.error('');
    console.error('Both token acquisitions failed. Likely causes:');
    console.error('  - self:write-document not enabled on Build Integrations app');
    console.error('    → enable it in Dev Console and re-run');
    console.error('  - vanta-api.documents:upload not granted to Manage Vanta app');
    console.error('    → check Dev Console scope availability');
    process.exit(1);
  }

  const uploadPath = `/v1/documents/${encodeURIComponent(documentId)}/uploads`;
  const filePart = (suffix) => ({
    name: 'file',
    filename: fileForProbe(suffix),
    contentType: 'text/plain',
    value: probeFileContent
  });

  // ── Probe 1: original-plan path (wrong, expected 404/405) ───────────────
  if (buildToken.ok) {
    await multipartUpload({
      token: buildToken.token,
      fullPath: '/v1/documents/upload',
      parts: [filePart('wrongpath-build')],
      label: '1 · NEGATIVE TEST — POST /v1/documents/upload (the ORIGINAL plan path, expected 404/405)'
    });
  }

  // ── Probe 2: corrected path via Build Integrations, four metadata variants ──
  // File-only first, then incrementally add metadata. If file-only 400s with
  // a "missing required field" body, the subsequent variants reveal whether
  // description, effectiveAtDate, or both unlock acceptance. If file-only
  // 200s, the metadata variants confirm Vanta accepts optional metadata
  // alongside the file.
  let build_FileOnly = null;
  let build_WithDesc = null;
  let build_WithDate = null;
  let build_WithBoth = null;
  if (buildToken.ok) {
    build_FileOnly = await multipartUpload({
      token: buildToken.token,
      fullPath: uploadPath,
      parts: [filePart('build-fileonly')],
      label: `2a · BUILD · file ONLY — no metadata parts`
    });
    build_WithDesc = await multipartUpload({
      token: buildToken.token,
      fullPath: uploadPath,
      parts: [
        filePart('build-with-desc'),
        { name: 'description', value: `LlamaLync probe ${stamp} — description metadata variant.` }
      ],
      label: `2b · BUILD · file + description`
    });
    build_WithDate = await multipartUpload({
      token: buildToken.token,
      fullPath: uploadPath,
      parts: [
        filePart('build-with-date'),
        { name: 'effectiveAtDate', value: isoToday }
      ],
      label: `2c · BUILD · file + effectiveAtDate (${isoToday})`
    });
    build_WithBoth = await multipartUpload({
      token: buildToken.token,
      fullPath: uploadPath,
      parts: [
        filePart('build-with-both'),
        { name: 'description', value: `LlamaLync probe ${stamp} — full metadata variant.` },
        { name: 'effectiveAtDate', value: isoToday }
      ],
      label: `2d · BUILD · file + description + effectiveAtDate`
    });
  }

  // ── Probe 3: same path via Manage Vanta token (one call, most-likely combo) ──
  // Single Manage probe is enough — Q2 just needs a yes/no per surface, and
  // the metadata variants for Build already pin down Q5's required-fields
  // answer. Using a distinct filename so this attachment is identifiable
  // against the Build-side ones in the Vanta UI.
  let manage_WithBoth = null;
  if (manageToken.ok) {
    manage_WithBoth = await multipartUpload({
      token: manageToken.token,
      fullPath: uploadPath,
      parts: [
        filePart('manage'),
        { name: 'description', value: `LlamaLync probe ${stamp} — Manage Vanta surface confirmation.` },
        { name: 'effectiveAtDate', value: isoToday }
      ],
      label: `3 · MANAGE · file + description + effectiveAtDate (vanta-api.documents:upload)`
    });
  }

  // Convenience: pick the "best" Build-side outcome to drive downstream logic.
  const bestBuild = [build_WithBoth, build_WithDate, build_WithDesc, build_FileOnly]
    .find(r => r?.ok) || build_WithBoth || build_FileOnly;

  // ── Probe 4: try alternate multipart field names if every metadata variant 400'd ──
  // Trigger only if no Build metadata variant succeeded AND Manage didn't
  // succeed either — that pattern points at a field-name issue rather than
  // a required-metadata issue. Use the full-metadata variant so the field
  // name is the only changing axis.
  const allMetadataFailed = [build_FileOnly, build_WithDesc, build_WithDate, build_WithBoth]
    .every(r => r && !r.ok && r.status === 400);
  const fieldNameProbeStatus = allMetadataFailed && !manage_WithBoth?.ok;
  let fieldVariantResults = null;
  if (fieldNameProbeStatus) {
    fieldVariantResults = [];
    const variants = ['document', 'evidence', 'attachment'];
    const tokenForVariants = buildToken.token;
    for (const variantName of variants) {
      const r = await multipartUpload({
        token: tokenForVariants,
        fullPath: uploadPath,
        parts: [
          {
            name: variantName,
            filename: fileForProbe(`fieldvar-${variantName}`),
            contentType: 'text/plain',
            value: probeFileContent
          },
          { name: 'description', value: `LlamaLync probe ${stamp} — field-name variant "${variantName}".` },
          { name: 'effectiveAtDate', value: isoToday }
        ],
        label: `4 · Field-name variant — form field "${variantName}" instead of "file"`
      });
      fieldVariantResults.push({ name: variantName, ok: r.ok, status: r.status, body: r.body });
    }
  }

  // ── Probe 5: invalid documentId — capture error shape for the missing case ──
  if (buildToken.ok) {
    await multipartUpload({
      token: buildToken.token,
      fullPath: `/v1/documents/llamalync-probe-nonexistent-${Date.now()}/uploads`,
      parts: [filePart('invalid-targetid')],
      label: '5 · POST with INVALID documentId — capture missing-target error shape'
    });
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');

  console.log('');
  console.log('Q1 — Is self:write-document enabled on the Build Integrations app?');
  if (buildToken.ok) {
    console.log('  YES — OAuth issued a token with self:write-document scope.');
    console.log('  Safe to add `self:write-document` to buildAuth.scope in Phase 3.');
  } else {
    console.log('  NO — OAuth rejected the scope. Enable self:write-document in Dev Console first.');
    console.log('  Token error status was:', buildToken.status);
  }

  console.log('');
  console.log('Q2 — Which surface owns the upload?');
  const buildOk = !!bestBuild?.ok;
  const manageOk = !!manage_WithBoth?.ok;
  if (buildOk && manageOk)       console.log('  BOTH — Build Integrations and Manage Vanta both accept the upload.');
  else if (buildOk)               console.log('  BUILD INTEGRATIONS only — use buildClient + self:write-document in implementation.');
  else if (manageOk)              console.log('  MANAGE VANTA only — use manageClient + vanta-api.documents:upload in implementation.');
  else                            console.log('  NEITHER succeeded — inspect probe bodies above before implementing.');

  console.log('');
  console.log('Q3 — Path confirmation');
  console.log('  Original plan path /v1/documents/upload — see Probe 1 status above.');
  console.log(`  Corrected path /v1/documents/${documentId}/uploads — Probes 2a–2d / 3 status above.`);

  console.log('');
  console.log('Q4 — Multipart field name');
  if (buildOk || manageOk) {
    console.log('  "file" worked (a Probe 2 / Probe 3 variant succeeded with that field name).');
  } else if (fieldVariantResults) {
    const winner = fieldVariantResults.find(r => r.ok);
    if (winner) {
      console.log(`  "${winner.name}" worked — use it in the implementation.`);
    } else {
      console.log('  No variant succeeded. Required field name unknown — inspect bodies above.');
    }
  } else {
    console.log('  Not exercised — every Build metadata variant 200\'d or Manage 200\'d, so the file');
    console.log('  field name is confirmed and field-name variants were skipped.');
  }

  console.log('');
  console.log('Q5 — Required metadata (description / effectiveAtDate)');
  const buildVariantOutcomes = [
    { label: '2a file only            ', r: build_FileOnly },
    { label: '2b file + description   ', r: build_WithDesc },
    { label: '2c file + effectiveDate ', r: build_WithDate },
    { label: '2d file + both metadata ', r: build_WithBoth }
  ];
  console.log('  BUILD-side metadata-variant outcomes:');
  for (const v of buildVariantOutcomes) {
    if (v.r == null) {
      console.log(`    ${v.label} — (skipped: Build token unavailable)`);
    } else {
      console.log(`    ${v.label} — ${v.r.ok ? 'OK' : `status=${v.r.status}`}`);
    }
  }
  if (build_FileOnly?.ok) {
    console.log('  → file-only succeeded; description and effectiveAtDate are OPTIONAL.');
  } else if (build_WithBoth?.ok && !build_FileOnly?.ok) {
    if (!build_WithDesc?.ok && !build_WithDate?.ok) {
      console.log('  → Vanta required BOTH description AND effectiveAtDate; neither alone unlocked acceptance.');
    } else if (build_WithDesc?.ok && !build_WithDate?.ok) {
      console.log('  → Vanta required `description`; effectiveAtDate is OPTIONAL.');
    } else if (!build_WithDesc?.ok && build_WithDate?.ok) {
      console.log('  → Vanta required `effectiveAtDate`; description is OPTIONAL.');
    } else {
      console.log('  → Either description OR effectiveAtDate alone unlocked acceptance — likely independent optional metadata.');
    }
  } else {
    console.log('  → No Build variant succeeded — inspect Probe 2 bodies for the actual required-field message.');
  }

  console.log('');
  console.log('Q6 — Response shape');
  console.log('  See the response bodies for the successful Probe 2 / Probe 3 variants above. Capture:');
  console.log('    - documentId echo / uploadId / contentUrl / persistence pointer');
  console.log('    - any audit fields (createdAt, uploadedBy)');
  console.log('  These drive what evidenceUpload.js surfaces back to the dashboard.');

  console.log('');
  console.log('───────────────────────────────────────────────────────────');
  console.log('Cleanup: the probe attached up to 7 small placeholder .txt files');
  console.log('to the target documentId (one per probe variant, distinct filenames');
  console.log('prefixed `llamalync-probe-{stamp}-...`). Remove via Vanta UI →');
  console.log('Documents → that document.');
  console.log('');
  console.log('Note: standalone OAuth in this probe revoked the in-process tokens');
  console.log('cached by src/auth/authManager.js. If the dashboard server was');
  console.log('running, the next request on each surface will hit one 401 and');
  console.log('auto-recover (see vantaClient.js:118-122).');
  console.log('');
  console.log('Next: paste the probe output into a new section of docs/build-log.md.');
  console.log('Pay particular attention to Q1 (scope enabled?) and Q2 (which surface).');
  console.log('───────────────────────────────────────────────────────────');
}

main().catch(err => {
  console.error('Probe script crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
