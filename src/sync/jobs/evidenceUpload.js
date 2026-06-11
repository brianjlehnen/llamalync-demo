const path = require('path');
const { buildClient } = require('../../http/vantaClient');
const {
  loadEvidenceFiles: defaultLoadEvidenceFiles,
  readEvidenceFile: defaultReadEvidenceFile,
  recordUpload: defaultRecordUpload
} = require('../../mockEvidenceStore');
const logger = require('../../utils/logger');

// Vanta's evidence-document upload endpoint. The path uses the SLOT SLUG
// (e.g. `access-requests`, `audit-cycle-documented`), NOT an arbitrary
// document id — Phase 0 finding: "Documents" in Vanta are pre-defined
// evidence-request slots, not free-form documents (see docs/build-log.md
// "Document upload — what's different"). Multipart body with one required
// `file` part plus optional `description` and `effectiveAtDate` parts.
//
// Routes through buildClient + the new self:write-document scope on
// buildAuth. Both Build Integrations and Manage Vanta accept this endpoint;
// the implementation uses Build Integrations as the canonical "extending
// Vanta with customer data" surface and to keep document uploads in the
// 20/min Build bucket separate from the 50/min Manage Vanta bucket.
function evidenceUploadPath(slotId) {
  return `/v1/documents/${encodeURIComponent(slotId)}/uploads`;
}

/**
 * Upload one evidence file to one Vanta evidence-request slot.
 *
 * Defaults are wired for the dashboard / CLI path. The function accepts
 * dependency injection (loadEvidenceFiles / readEvidenceFile / recordUpload
 * / vantaClient) the same way runRiskSync does, so tests can stub everything
 * without touching the real network or filesystem.
 *
 *   filename:        manifest filename (e.g. "access-review-2026-Q1.csv")
 *   slotId:          optional — defaults to the manifest's targetSlot for
 *                    the file. Pass a value to override (e.g. dashboard's
 *                    "upload this file to a different slot" affordance).
 *   description:     optional override; defaults to the manifest description.
 *   effectiveAtDate: optional ISO date string. Vanta defaults effectiveDate
 *                    to upload time when this is omitted (Phase 0 finding).
 *
 * Throws on missing filename, unknown filename (not in manifest), or
 * Vanta error. Caller is responsible for catching + surfacing.
 */
async function runEvidenceUpload({
  filename,
  slotId = null,
  description = null,
  effectiveAtDate = null,
  readEvidenceFile = defaultReadEvidenceFile,
  recordUpload = defaultRecordUpload,
  vantaClient = buildClient
} = {}) {
  if (!filename) {
    const err = new Error('filename is required — must match a manifest entry in mock-data/evidence/_manifest.json');
    err.statusCode = 400;
    throw err;
  }

  // Read the file content + manifest entry. The mock store's readEvidenceFile
  // is allow-list-strict (prevents path traversal) so an arbitrary filename
  // from the dashboard / CLI can't escape the evidence directory.
  const fileResult = readEvidenceFile(filename);
  if (!fileResult.ok) {
    const err = new Error(fileResult.error);
    err.statusCode = fileResult.status || 404;
    throw err;
  }

  // Resolve the target slot — caller override wins, then manifest default.
  const targetSlot = slotId || fileResult.manifest.targetSlot;
  if (!targetSlot) {
    const err = new Error(
      `No target slot for ${filename}. Either set targetSlot in the manifest entry ` +
      `or pass slotId explicitly.`
    );
    err.statusCode = 400;
    throw err;
  }

  // Build multipart parts. The `file` part is required; description and
  // effectiveAtDate are optional and only included when present (verified
  // in Phase 0 — file-only uploads succeed with metadata defaulting on the
  // Vanta side).
  const parts = [{
    name:        'file',
    filename:    fileResult.manifest.filename,
    contentType: fileResult.mimeType,
    value:       fileResult.content
  }];
  const effectiveDescription = description || fileResult.manifest.description;
  if (effectiveDescription) {
    parts.push({ name: 'description', value: effectiveDescription });
  }
  if (effectiveAtDate) {
    parts.push({ name: 'effectiveAtDate', value: effectiveAtDate });
  }

  const apiPath = evidenceUploadPath(targetSlot);
  logger.info('Uploading evidence file to Vanta', {
    filename,
    targetSlot,
    apiPath,
    byteLength: fileResult.content.length,
    hasDescription: Boolean(effectiveDescription),
    hasEffectiveAtDate: Boolean(effectiveAtDate)
  });

  const response = await vantaClient.postMultipart(apiPath, parts);

  // Track in-session so the dashboard can render the "✓ uploaded" indicator
  // on this filename without re-reading Vanta's full document list per
  // render. Phase 0 finding: each upload generates a NEW uploadId (Vanta
  // treats each call as a separate revision on the slot, not an overwrite).
  recordUpload(filename, targetSlot, response);

  logger.info('Evidence upload complete', {
    filename,
    targetSlot,
    vantaUploadId: response?.id,
    vantaUrl: response?.url
  });

  return {
    filename,
    targetSlot,
    byteLength: fileResult.content.length,
    response
  };
}

// Allow running directly:
//   node src/sync/jobs/evidenceUpload.js <filename> [slotId]
// Example:
//   node src/sync/jobs/evidenceUpload.js access-review-2026-Q1.csv
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
  const filename = process.argv[2];
  const slotId = process.argv[3] || null;
  if (!filename) {
    console.error('Usage: node src/sync/jobs/evidenceUpload.js <filename> [slotId]');
    console.error('');
    console.error('Available filenames (from mock-data/evidence/_manifest.json):');
    try {
      const { data } = defaultLoadEvidenceFiles();
      for (const f of data) {
        console.error(`  ${f.filename}  →  ${f.targetSlot}`);
      }
    } catch (e) {
      console.error('  (manifest read failed: ' + e.message + ')');
    }
    process.exit(1);
  }
  runEvidenceUpload({ filename, slotId }).then(stats => {
    logger.info('Done', {
      filename: stats.filename,
      slot: stats.targetSlot,
      bytes: stats.byteLength,
      vantaUploadId: stats.response?.id
    });
  }).catch(err => {
    logger.error('Evidence upload failed', { error: err.message, status: err.statusCode });
    process.exit(1);
  });
}

module.exports = { runEvidenceUpload, evidenceUploadPath };
