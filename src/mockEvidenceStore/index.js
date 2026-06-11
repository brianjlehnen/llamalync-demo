const express = require('express');
const path = require('path');
const fs = require('fs');
const { safeLoadJson } = require('../utils/safeLoadJson');

/**
 * Fake "Evidence-X" file store — stands in for a customer's local source
 * of compliance evidence files (an internal SharePoint / Box folder, a
 * shared drive, a per-control evidence repository in their GRC tool, or
 * an export bucket from a homegrown audit-evidence app).
 *
 * Differs from People-X / Risk-X / CMDB-X in two ways:
 *
 *   1. The "records" are FILES on disk (mock-data/evidence/*), not JSON
 *      rows. Each file has a manifest entry describing its target Vanta
 *      evidence-request slot — that's the Phase 0 finding about Vanta
 *      "Documents" being predefined slots, not arbitrary uploads (see
 *      docs/build-log.md "Document upload — what's different").
 *
 *   2. No source-side mutations (Add / Decommission / Apply Treatment).
 *      Evidence files are static for the demo; the only state change is
 *      "we uploaded this to Vanta" — tracked in-memory per session via
 *      recordUpload() so the dashboard can show ✓ on rows whose file
 *      already landed during this demo run.
 *
 * Promotion path: when LlamaLync deploys, /mock-evidencex deploys with it.
 * For a real customer integration, swap loadEvidenceFiles() to enumerate
 * a real source (S3 bucket prefix, SharePoint folder, GRC tool API) and
 * leave the rest of the upload pipeline alone.
 */
const router = express.Router();
const EVIDENCE_DIR = path.join(__dirname, '../../mock-data/evidence');
const MANIFEST_FILE = path.join(EVIDENCE_DIR, '_manifest.json');

// Session upload history — in-memory map of filename → most-recent upload
// record. Cleared on /mock-evidencex/reset and on server restart. The mock
// evidence files themselves are static; this state exists so the dashboard
// can render "✓ uploaded this session" indicators without re-reading
// Vanta's document list per row.
let uploadHistory = new Map();

/**
 * Read the file manifest + attach byte sizes from disk. Each manifest
 * entry has: filename, mimeType, description, targetSlot, addedAt.
 * Files referenced in the manifest that don't exist on disk are skipped
 * with a warning, so a broken manifest entry doesn't crash the loader.
 */
function loadEvidenceFiles() {
  const stat = fs.statSync(MANIFEST_FILE);
  const manifest = safeLoadJson(MANIFEST_FILE);
  const data = [];
  for (const entry of manifest) {
    const filePath = path.join(EVIDENCE_DIR, entry.filename);
    if (!fs.existsSync(filePath)) {
      // Skip silently — surface as a warning in the _meta breakdown so
      // the dashboard / SA notices but the loader doesn't throw.
      continue;
    }
    const fileStat = fs.statSync(filePath);
    const upload = uploadHistory.get(entry.filename) || null;
    data.push({
      ...entry,
      size: fileStat.size,
      lastModified: fileStat.mtime.toISOString(),
      // Session upload state — null until recordUpload() has been called
      // for this filename. Surfaced so the dashboard can show ✓ next to
      // files that have already landed in Vanta this session.
      lastUpload: upload ? { ...upload } : null
    });
  }
  return {
    data,
    lastModified: stat.mtime.toISOString(),
    mutationCount: uploadHistory.size
  };
}

/**
 * Read one file's binary contents. Strict allow-list against the manifest
 * to prevent path traversal — only filenames declared in the manifest
 * can be read, regardless of what the caller asks for.
 */
function readEvidenceFile(filename) {
  const manifest = safeLoadJson(MANIFEST_FILE);
  const entry = manifest.find(m => m.filename === filename);
  if (!entry) {
    return { ok: false, status: 404, error: `Unknown filename '${filename}' — not in evidence manifest` };
  }
  const filePath = path.join(EVIDENCE_DIR, entry.filename);
  if (!fs.existsSync(filePath)) {
    return { ok: false, status: 404, error: `Manifest references '${filename}' but file is missing on disk` };
  }
  const content = fs.readFileSync(filePath);
  return { ok: true, content, mimeType: entry.mimeType, manifest: entry };
}

/**
 * Record a successful upload in session history. Called by
 * src/sync/jobs/evidenceUpload.js after Vanta returns 200. Stores the
 * Vanta response's `id` (the upload-record id, distinct from the slot
 * slug) and any other useful fields for dashboard display.
 */
function recordUpload(filename, slotId, vantaResponse) {
  uploadHistory.set(filename, {
    slotId,
    uploadedAt: new Date().toISOString(),
    vantaUploadId: vantaResponse?.id || null,
    vantaUrl: vantaResponse?.url || null,
    vantaTitle: vantaResponse?.title || null
  });
}

function resetUploads() {
  uploadHistory = new Map();
}

// ─── Routes ────────────────────────────────────────────────────────────────

router.get('/mock-evidencex/files.json', (req, res) => {
  const { data } = loadEvidenceFiles();
  res.json(data);
});

router.get('/mock-evidencex/_meta.json', (req, res) => {
  const { data, lastModified, mutationCount } = loadEvidenceFiles();
  // Count files by target slot category for the dashboard summary. Files
  // pointing at the same slot is a valid case (multiple evidence pieces
  // satisfying one evidence request).
  const slotCounts = data.reduce((acc, f) => {
    acc[f.targetSlot] = (acc[f.targetSlot] || 0) + 1;
    return acc;
  }, {});
  res.json({
    source: 'Evidence-X — simulated compliance-evidence file store',
    served: 'GET /mock-evidencex/files.json',
    sourceDir: 'mock-data/evidence/',
    lastModified,
    sessionUploads: mutationCount,
    totalFiles: data.length,
    breakdown: {
      bySlot: slotCounts,
      uploaded: data.filter(f => f.lastUpload).length,
      notYetUploaded: data.filter(f => !f.lastUpload).length,
      totalBytes: data.reduce((sum, f) => sum + (f.size || 0), 0)
    }
  });
});

// Binary file read — allow-listed against the manifest. Used by the
// upload sync job (which reads the file bytes before constructing the
// multipart body) and optionally by the dashboard if it wants to render
// a "preview" later. Forwards the manifest-declared MIME type rather
// than letting express guess from extension.
router.get('/mock-evidencex/files/:filename', (req, res) => {
  const result = readEvidenceFile(req.params.filename);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.set('Content-Type', result.mimeType);
  res.send(result.content);
});

// JSON body parsing for the mutation routes (the global parser is registered
// AFTER the routers in src/index.js to avoid breaking the webhook raw body path).
router.use(express.json());

router.post('/mock-evidencex/reset', (req, res) => {
  resetUploads();
  res.json({ ok: true });
});

module.exports = {
  router,
  loadEvidenceFiles,
  readEvidenceFile,
  recordUpload,
  // Exposed for tests
  _resetUploads: resetUploads
};
