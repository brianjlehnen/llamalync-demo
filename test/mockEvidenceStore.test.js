const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const mockEvidenceStore = require('../src/mockEvidenceStore');
const {
  loadEvidenceFiles,
  readEvidenceFile,
  recordUpload,
  _resetUploads
} = mockEvidenceStore;

beforeEach(() => {
  _resetUploads();
});

describe('loadEvidenceFiles — manifest read', () => {
  test('returns the manifest entries with size + lastUpload attached', () => {
    const { data } = loadEvidenceFiles();
    assert.ok(data.length >= 3, 'manifest must keep at least 3 files for the demo');
    for (const f of data) {
      assert.ok(typeof f.filename === 'string');
      assert.ok(typeof f.size === 'number' && f.size > 0, `${f.filename} must have size > 0`);
      assert.ok(typeof f.mimeType === 'string');
      assert.ok(typeof f.targetSlot === 'string');
      assert.strictEqual(f.lastUpload, null, 'no uploads on fresh load');
    }
  });

  test('each manifest entry maps to a real Vanta evidence-request slot slug', () => {
    // The point of the manifest is that targetSlot binds to a real slot
    // in the customer's tenant. The values here are the slugs from the
    // Phase 0 probe — if someone renames them, the integration breaks.
    const { data } = loadEvidenceFiles();
    const slots = data.map(f => f.targetSlot);
    // Format expectation: lowercase-hyphenated slug, no spaces
    for (const slot of slots) {
      assert.match(slot, /^[a-z0-9-]+$/, `slot "${slot}" must be a lowercase-hyphenated slug`);
    }
  });

  test('mutationCount is zero on a fresh load (no recordUpload calls)', () => {
    const { mutationCount } = loadEvidenceFiles();
    assert.strictEqual(mutationCount, 0);
  });
});

describe('readEvidenceFile — content + allow-list', () => {
  test('returns file content + mimeType for a manifest filename', () => {
    const result = readEvidenceFile('access-review-2026-Q1.csv');
    assert.strictEqual(result.ok, true);
    assert.ok(Buffer.isBuffer(result.content));
    assert.ok(result.content.length > 0);
    assert.strictEqual(result.mimeType, 'text/csv');
    assert.strictEqual(result.manifest.targetSlot, 'access-requests');
  });

  test('rejects unknown filenames (allow-list strict)', () => {
    const result = readEvidenceFile('nonexistent-file.txt');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
    assert.match(result.error, /not in evidence manifest/);
  });

  test('rejects path-traversal attempts that escape the evidence directory', () => {
    // Path-traversal defense lives in the manifest allow-list: any
    // filename not literally in the manifest is rejected. Even though
    // /etc/passwd exists on disk, it isn't an evidence file.
    const result = readEvidenceFile('../../etc/passwd');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
  });

  test('rejects absolute paths', () => {
    const result = readEvidenceFile('/etc/passwd');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
  });

  test('rejects filenames with directory separators', () => {
    const result = readEvidenceFile('subdir/file.txt');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
  });
});

describe('recordUpload + session history', () => {
  test('recordUpload populates lastUpload on subsequent loadEvidenceFiles() calls', () => {
    const filename = 'access-review-2026-Q1.csv';
    recordUpload(filename, 'access-requests', {
      id: 'mongo-id-abc',
      url: 'https://app.vanta.com/.../doc/Manual%20Evidence-xyz',
      title: 'Manual Evidence'
    });

    const { data, mutationCount } = loadEvidenceFiles();
    assert.strictEqual(mutationCount, 1);

    const target = data.find(f => f.filename === filename);
    assert.ok(target.lastUpload, 'lastUpload must be set after recordUpload');
    assert.strictEqual(target.lastUpload.slotId, 'access-requests');
    assert.strictEqual(target.lastUpload.vantaUploadId, 'mongo-id-abc');
    assert.match(target.lastUpload.uploadedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('repeat upload of the same filename overwrites the prior record (latest-wins)', () => {
    recordUpload('access-review-2026-Q1.csv', 'access-requests', { id: 'old-id' });
    recordUpload('access-review-2026-Q1.csv', 'access-requests', { id: 'new-id' });
    const { data, mutationCount } = loadEvidenceFiles();
    assert.strictEqual(mutationCount, 1, 'still one tracked file (latest-wins)');
    const target = data.find(f => f.filename === 'access-review-2026-Q1.csv');
    assert.strictEqual(target.lastUpload.vantaUploadId, 'new-id');
  });

  test('recordUpload tolerates a Vanta response with missing optional fields', () => {
    recordUpload('access-review-2026-Q1.csv', 'access-requests', {});
    const { data } = loadEvidenceFiles();
    const target = data.find(f => f.filename === 'access-review-2026-Q1.csv');
    assert.strictEqual(target.lastUpload.vantaUploadId, null);
    assert.strictEqual(target.lastUpload.vantaUrl, null);
  });

  test('_resetUploads clears all session history', () => {
    recordUpload('access-review-2026-Q1.csv', 'access-requests', { id: 'a' });
    recordUpload('audit-cycle-2026-plan.txt', 'audit-cycle-documented', { id: 'b' });
    assert.strictEqual(loadEvidenceFiles().mutationCount, 2);
    _resetUploads();
    assert.strictEqual(loadEvidenceFiles().mutationCount, 0);
  });
});
