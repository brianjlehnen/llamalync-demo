const { describe, test } = require('node:test');
const assert = require('node:assert');

const { runEvidenceUpload, evidenceUploadPath } = require('../src/sync/jobs/evidenceUpload');

// ─── Helpers ────────────────────────────────────────────────────────────────

// Stub the evidence-store reader. Returns whatever the test sets up — used
// to inject controlled file content + manifest metadata into runEvidenceUpload
// without touching the real filesystem.
function stubReadEvidenceFile({ ok = true, content = Buffer.from('test'), mimeType = 'text/plain', manifest = null, status = 404, error = '' } = {}) {
  return (filename) => {
    if (!ok) return { ok: false, status, error };
    return {
      ok: true,
      content,
      mimeType,
      manifest: manifest || { filename, mimeType, targetSlot: 'audit-cycle-documented', description: 'test description' }
    };
  };
}

// Stub vantaClient that captures the postMultipart call. Lets tests assert
// on the request path + multipart parts without sending anything over the
// wire.
function stubVantaClient(responseBody = { id: 'mock-upload-id', url: 'https://app.vanta.com/.../mock', title: 'Manual Evidence' }) {
  const calls = [];
  return {
    calls,
    async postMultipart(path, parts) {
      calls.push({ path, parts });
      return responseBody;
    }
  };
}

// Stub recordUpload that captures invocations.
function stubRecordUpload() {
  const calls = [];
  return {
    calls,
    fn: (filename, slotId, response) => calls.push({ filename, slotId, response })
  };
}

// Convenience: build runEvidenceUpload opts with safe stubs.
function uploadOpts(overrides = {}) {
  const recorder = stubRecordUpload();
  const client = stubVantaClient();
  return {
    opts: {
      readEvidenceFile: stubReadEvidenceFile(),
      recordUpload: recorder.fn,
      vantaClient: client,
      ...overrides
    },
    recorder,
    client
  };
}

// ─── evidenceUploadPath ─────────────────────────────────────────────────────

describe('evidenceUploadPath', () => {
  test('returns the slug-based path Vanta expects (verified Phase 0 2026-05-13)', () => {
    assert.strictEqual(
      evidenceUploadPath('access-requests'),
      '/v1/documents/access-requests/uploads'
    );
  });

  test('URL-encodes the slot id (defense vs operator-supplied slot strings)', () => {
    assert.strictEqual(
      evidenceUploadPath('weird/slot id'),
      '/v1/documents/weird%2Fslot%20id/uploads'
    );
  });
});

// ─── runEvidenceUpload — argument validation ────────────────────────────────

describe('runEvidenceUpload — argument validation', () => {
  test('throws when filename is missing', async () => {
    await assert.rejects(
      () => runEvidenceUpload(uploadOpts().opts),  // no filename
      /filename is required/
    );
  });

  test('surfaces 404 when readEvidenceFile rejects the filename', async () => {
    const { opts } = uploadOpts({
      readEvidenceFile: stubReadEvidenceFile({ ok: false, status: 404, error: 'Unknown filename' })
    });
    await assert.rejects(
      () => runEvidenceUpload({ ...opts, filename: 'bogus.txt' }),
      (err) => err.statusCode === 404 && /Unknown filename/.test(err.message)
    );
  });

  test('throws 400 when neither manifest nor caller provides a slotId', async () => {
    const { opts } = uploadOpts({
      // manifest with no targetSlot
      readEvidenceFile: stubReadEvidenceFile({
        manifest: { filename: 'x.txt', mimeType: 'text/plain', targetSlot: null, description: null }
      })
    });
    await assert.rejects(
      () => runEvidenceUpload({ ...opts, filename: 'x.txt' }),
      (err) => err.statusCode === 400 && /No target slot/.test(err.message)
    );
  });
});

// ─── runEvidenceUpload — multipart construction ─────────────────────────────

describe('runEvidenceUpload — multipart construction', () => {
  test('issues POST to /v1/documents/{slot}/uploads using the manifest targetSlot', async () => {
    const { opts, client } = uploadOpts();
    await runEvidenceUpload({ ...opts, filename: 'audit-cycle-2026-plan.txt' });
    assert.strictEqual(client.calls.length, 1);
    assert.strictEqual(client.calls[0].path, '/v1/documents/audit-cycle-documented/uploads');
  });

  test('slotId override beats the manifest targetSlot', async () => {
    const { opts, client } = uploadOpts();
    await runEvidenceUpload({ ...opts, filename: 'audit-cycle-2026-plan.txt', slotId: 'access-requests' });
    assert.strictEqual(client.calls[0].path, '/v1/documents/access-requests/uploads');
  });

  test('multipart parts include `file` with manifest filename + mimeType + content', async () => {
    const fileBytes = Buffer.from('mock file contents');
    const { opts, client } = uploadOpts({
      readEvidenceFile: stubReadEvidenceFile({
        content: fileBytes,
        mimeType: 'text/csv',
        manifest: { filename: 'data.csv', mimeType: 'text/csv', targetSlot: 'access-requests', description: 'desc' }
      })
    });
    await runEvidenceUpload({ ...opts, filename: 'data.csv' });

    const filePart = client.calls[0].parts.find(p => p.name === 'file');
    assert.ok(filePart, 'multipart must include a `file` part');
    assert.strictEqual(filePart.filename, 'data.csv');
    assert.strictEqual(filePart.contentType, 'text/csv');
    assert.ok(filePart.value.equals(fileBytes), 'file content bytes must round-trip unchanged');
  });

  test('includes a `description` part by default (from manifest)', async () => {
    const { opts, client } = uploadOpts({
      readEvidenceFile: stubReadEvidenceFile({
        manifest: { filename: 'x.txt', mimeType: 'text/plain', targetSlot: 'access-requests', description: 'manifest desc' }
      })
    });
    await runEvidenceUpload({ ...opts, filename: 'x.txt' });
    const descPart = client.calls[0].parts.find(p => p.name === 'description');
    assert.ok(descPart);
    assert.strictEqual(descPart.value, 'manifest desc');
  });

  test('description override wins over manifest', async () => {
    const { opts, client } = uploadOpts({
      readEvidenceFile: stubReadEvidenceFile({
        manifest: { filename: 'x.txt', mimeType: 'text/plain', targetSlot: 'access-requests', description: 'manifest desc' }
      })
    });
    await runEvidenceUpload({ ...opts, filename: 'x.txt', description: 'caller desc' });
    const descPart = client.calls[0].parts.find(p => p.name === 'description');
    assert.strictEqual(descPart.value, 'caller desc');
  });

  test('omits description part entirely when neither manifest nor caller provides one', async () => {
    const { opts, client } = uploadOpts({
      readEvidenceFile: stubReadEvidenceFile({
        manifest: { filename: 'x.txt', mimeType: 'text/plain', targetSlot: 'access-requests', description: null }
      })
    });
    await runEvidenceUpload({ ...opts, filename: 'x.txt' });
    const descPart = client.calls[0].parts.find(p => p.name === 'description');
    assert.strictEqual(descPart, undefined, 'no description part should be sent');
  });

  test('includes effectiveAtDate only when provided', async () => {
    const { opts, client } = uploadOpts();
    await runEvidenceUpload({ ...opts, filename: 'x.txt' });
    assert.strictEqual(
      client.calls[0].parts.find(p => p.name === 'effectiveAtDate'),
      undefined,
      'no effectiveAtDate without caller-provided value'
    );

    const second = uploadOpts();
    await runEvidenceUpload({ ...second.opts, filename: 'x.txt', effectiveAtDate: '2026-05-14' });
    const ePart = second.client.calls[0].parts.find(p => p.name === 'effectiveAtDate');
    assert.ok(ePart);
    assert.strictEqual(ePart.value, '2026-05-14');
  });
});

// ─── runEvidenceUpload — recordUpload + return value ────────────────────────

describe('runEvidenceUpload — recordUpload + return value', () => {
  test('calls recordUpload with the filename, target slot, and Vanta response', async () => {
    const response = { id: 'vanta-upload-xyz', url: 'https://...', title: 'Manual Evidence' };
    const { opts, recorder } = uploadOpts({ vantaClient: stubVantaClient(response) });
    await runEvidenceUpload({ ...opts, filename: 'x.txt' });
    assert.strictEqual(recorder.calls.length, 1);
    assert.strictEqual(recorder.calls[0].filename, 'x.txt');
    assert.strictEqual(recorder.calls[0].slotId, 'audit-cycle-documented');
    assert.strictEqual(recorder.calls[0].response.id, 'vanta-upload-xyz');
  });

  test('returns { filename, targetSlot, byteLength, response }', async () => {
    const fileBytes = Buffer.from('abcdef');
    const response = { id: 'r' };
    const { opts } = uploadOpts({
      readEvidenceFile: stubReadEvidenceFile({ content: fileBytes }),
      vantaClient: stubVantaClient(response)
    });
    const stats = await runEvidenceUpload({ ...opts, filename: 'x.txt' });
    assert.strictEqual(stats.filename, 'x.txt');
    assert.strictEqual(stats.targetSlot, 'audit-cycle-documented');
    assert.strictEqual(stats.byteLength, 6);
    assert.strictEqual(stats.response.id, 'r');
  });

  test('does NOT call recordUpload when the Vanta call throws', async () => {
    const failingClient = {
      async postMultipart() { throw new Error('boom'); }
    };
    const { opts, recorder } = uploadOpts({ vantaClient: failingClient });
    await assert.rejects(() => runEvidenceUpload({ ...opts, filename: 'x.txt' }), /boom/);
    assert.strictEqual(recorder.calls.length, 0, 'no upload record on failure');
  });
});
