const { describe, test } = require('node:test');
const assert = require('node:assert');

const { transformRisk, runRiskSync } = require('../src/sync/jobs/riskSync');

const TEST_REGISTER = 'TestRegister';

function makeRisk(internalId, overrides = {}) {
  return {
    internalId,
    title: 'Title for ' + internalId,
    description: 'Description for ' + internalId,
    category: 'Access Control',
    ciaImpact: ['Confidentiality'],
    inherent: { likelihood: 4, impact: 5 },
    currentMitigations: 'Audit logs retained 90 days; quarterly review.',
    residual: { likelihood: 2, impact: 4 },
    treatment: 'Mitigate',
    ownerEmail: 'sec-lead@example.com',
    status: 'Open',
    lastReviewedAt: '2026-04-01',
    linkedControlIds: ['SOC2-CC6.1'],
    ...overrides
  };
}

// Convenience wrappers that inject the now-required riskRegister so each
// test reads cleanly. Tests that need to probe the required-register
// behavior call transformRisk / runRiskSync directly.
function tr(risk, opts = {}) {
  return transformRisk(risk, { riskRegister: TEST_REGISTER, ...opts });
}

function rrs(opts = {}) {
  return runRiskSync({ riskRegister: TEST_REGISTER, ...opts });
}

function findCustomField(payload, label) {
  return (payload.customFields || []).find(f => f.label === label);
}

describe('transformRisk — treated risk (currentMitigations populated)', () => {
  test('includes residualLikelihood / residualImpact / note', () => {
    const payload = tr(makeRisk('RX-1'), { forCreate: true });
    assert.strictEqual(payload.residualLikelihood, 2);
    assert.strictEqual(payload.residualImpact, 4);
    assert.strictEqual(payload.note, 'Audit logs retained 90 days; quarterly review.');
  });

  test('concatenates title + description with blank-line separator', () => {
    const payload = tr(makeRisk('RX-1'), { forCreate: true });
    assert.strictEqual(payload.description, 'Title for RX-1\n\nDescription for RX-1');
  });

  test('puts category into the categories array', () => {
    const payload = tr(makeRisk('RX-1'), { forCreate: true });
    assert.deepStrictEqual(payload.categories, ['Access Control']);
  });

  test('maps inherent scoring to top-level likelihood/impact', () => {
    const payload = tr(makeRisk('RX-1'), { forCreate: true });
    assert.strictEqual(payload.likelihood, 4);
    assert.strictEqual(payload.impact, 5);
  });

  test('owner email passes through when present', () => {
    const payload = tr(makeRisk('RX-1'), { forCreate: true });
    assert.strictEqual(payload.owner, 'sec-lead@example.com');
  });

  test('known owner passes preflight allow-list', () => {
    const payload = tr(makeRisk('RX-1'), {
      forCreate: true,
      knownOwnerEmails: new Set(['sec-lead@example.com'])
    });
    assert.strictEqual(payload.owner, 'sec-lead@example.com');
  });

  test('unknown owner is omitted on create', () => {
    const payload = tr(makeRisk('RX-1'), {
      forCreate: true,
      knownOwnerEmails: new Set(['someone-else@example.com'])
    });
    assert.ok(!('owner' in payload));
  });

  test('unknown owner is cleared on update', () => {
    const payload = tr(makeRisk('RX-1'), {
      forCreate: false,
      knownOwnerEmails: new Set(['someone-else@example.com'])
    });
    assert.strictEqual(payload.owner, null);
  });
});

describe('transformRisk — untreated risk (currentMitigations == null)', () => {
  test('POST omits residualLikelihood / residualImpact / note (nothing to clear yet)', () => {
    const payload = tr(makeRisk('RX-2', { currentMitigations: null }), { forCreate: true });
    assert.ok(!('residualLikelihood' in payload));
    assert.ok(!('residualImpact' in payload));
    assert.ok(!('note' in payload));
  });

  test('PATCH sends EXPLICIT null for residualLikelihood / residualImpact / note', () => {
    // Slice-4.5 probe finding: Vanta PATCH preserves omitted fields. Untreated
    // PATCH must send null to clear residual scoring from a prior treated state.
    const payload = tr(makeRisk('RX-2', { currentMitigations: null }), { forCreate: false });
    assert.strictEqual(payload.residualLikelihood, null);
    assert.strictEqual(payload.residualImpact, null);
    assert.strictEqual(payload.note, null);
  });

  test('still includes inherent likelihood/impact', () => {
    const payload = tr(makeRisk('RX-2', { currentMitigations: null }), { forCreate: true });
    assert.strictEqual(payload.likelihood, 4);
    assert.strictEqual(payload.impact, 5);
  });

  test('residual presence in source data does NOT defeat the untreated signal', () => {
    // Mirrors the slice-3 review feedback: mock data leaves residual === inherent
    // when untreated. The transform must use currentMitigations == null, not
    // residual-object presence, as the signal.
    const risk = makeRisk('RX-2', {
      currentMitigations: null,
      residual: { likelihood: 4, impact: 5 }  // same as inherent
    });
    const postPayload = tr(risk, { forCreate: true });
    assert.ok(!('residualLikelihood' in postPayload));
    assert.ok(!('residualImpact' in postPayload));

    // PATCH still nulls, regardless of source-side residual values.
    const patchPayload = tr(risk, { forCreate: false });
    assert.strictEqual(patchPayload.residualLikelihood, null);
    assert.strictEqual(patchPayload.residualImpact, null);
  });
});

describe('transformRisk — forCreate flag', () => {
  test('forCreate: true → riskId included for dedupe-on-resync', () => {
    const payload = tr(makeRisk('RX-3'), { forCreate: true });
    assert.strictEqual(payload.riskId, 'RX-3');
  });

  test('forCreate: false → riskId omitted (PATCH targets via path)', () => {
    const payload = tr(makeRisk('RX-3'), { forCreate: false });
    assert.ok(!('riskId' in payload));
  });
});

describe('transformRisk — strict enums', () => {
  test('CIA categories outside the canonical triad are dropped', () => {
    const risk = makeRisk('RX-4', {
      ciaImpact: ['Confidentiality', 'Auditability', 'Non-repudiation', 'Integrity']
    });
    const payload = tr(risk, { forCreate: true });
    assert.deepStrictEqual(payload.ciaCategories, ['Confidentiality', 'Integrity']);
  });

  test('unknown treatment defaults to Mitigate', () => {
    const payload = tr(makeRisk('RX-4', { treatment: 'WatchClosely' }), { forCreate: true });
    assert.strictEqual(payload.treatment, 'Mitigate');
  });

  test('known treatment passes through', () => {
    const payload = tr(makeRisk('RX-4', { treatment: 'Accept' }), { forCreate: true });
    assert.strictEqual(payload.treatment, 'Accept');
  });
});

describe('transformRisk — locked customFields contract', () => {
  test('SOURCE_ID, SOURCE_STATUS, SOURCE_LAST_REVIEWED are always present', () => {
    const payload = tr(makeRisk('RX-5'), { forCreate: true });
    assert.strictEqual(findCustomField(payload, 'Source Risk-X ID')?.value, 'RX-5');
    assert.strictEqual(findCustomField(payload, 'Source Status')?.value, 'Open');
    assert.strictEqual(findCustomField(payload, 'Source Last Reviewed')?.value, '2026-04-01');
  });

  test('SOURCE_CONTROL_IDS joined as comma-separated text (Vanta multi-select requires predefined options)', () => {
    const payload = tr(makeRisk('RX-5', { linkedControlIds: ['SOC2-CC6.1', 'ISO-A.9.4.3'] }), { forCreate: true });
    assert.strictEqual(
      findCustomField(payload, 'Source Control IDs')?.value,
      'SOC2-CC6.1, ISO-A.9.4.3'
    );
  });

  test('SOURCE_CONTROL_IDS omitted when linkedControlIds is empty', () => {
    const payload = tr(makeRisk('RX-5', { linkedControlIds: [] }), { forCreate: true });
    assert.strictEqual(findCustomField(payload, 'Source Control IDs'), undefined);
  });

  test('SOURCE_STATUS mirrors closed state for the workaround', () => {
    const payload = tr(makeRisk('RX-5', { status: 'Closed' }), { forCreate: true });
    assert.strictEqual(findCustomField(payload, 'Source Status')?.value, 'Closed');
  });
});

describe('transformRisk — riskRegister is required', () => {
  test('throws when riskRegister option is missing', () => {
    assert.throws(
      () => transformRisk(makeRisk('RX-6'), { forCreate: true }),
      /requires a riskRegister option/
    );
  });

  test('throws when riskRegister is an empty string', () => {
    assert.throws(
      () => transformRisk(makeRisk('RX-6'), { forCreate: true, riskRegister: '' }),
      /requires a riskRegister option/
    );
  });

  test('always includes riskRegister in POST payload', () => {
    const payload = transformRisk(makeRisk('RX-6'), { forCreate: true, riskRegister: 'Primary' });
    assert.strictEqual(payload.riskRegister, 'Primary');
  });

  test('always includes riskRegister in PATCH payload', () => {
    const payload = transformRisk(makeRisk('RX-6'), { forCreate: false, riskRegister: 'Primary' });
    assert.strictEqual(payload.riskRegister, 'Primary');
  });
});

describe('runRiskSync — routes diff buckets correctly', () => {
  function makeStubClient({
    vantaRows = [],
    peopleRows = [{ email: 'sec-lead@example.com' }],
    postBehavior,
    patchBehavior
  } = {}) {
    const calls = { fetchAllPages: [], post: [], patch: [] };
    return {
      calls,
      async fetchAllPages(path) {
        calls.fetchAllPages.push(path);
        return path === '/v1/people' ? peopleRows : vantaRows;
      },
      async post(path, body) {
        calls.post.push({ path, body });
        if (postBehavior) return postBehavior(path, body);
        return { ok: true };
      },
      async patch(path, body) {
        calls.patch.push({ path, body });
        if (patchBehavior) return patchBehavior(path, body);
        return { ok: true };
      }
    };
  }

  test('all source rows missing from Vanta → all POST, no PATCH', async () => {
    const sourceRows = [makeRisk('RX-A'), makeRisk('RX-B')];
    const client = makeStubClient({ vantaRows: [] });
    const stats = await rrs({
      loadRisks: () => ({ data: sourceRows }),
      vantaClient: client
    });
    assert.strictEqual(stats.created, 2);
    assert.strictEqual(stats.updated, 0);
    assert.strictEqual(client.calls.post.length, 2);
    assert.strictEqual(client.calls.patch.length, 0);
    for (const c of client.calls.post) {
      assert.strictEqual(c.path, '/v1/risk-scenarios');
    }
    assert.deepStrictEqual(client.calls.fetchAllPages, ['/v1/people', '/v1/risk-scenarios']);
  });

  test('mixed state → correct POST/PATCH split with riskScenarioId in PATCH path', async () => {
    const sourceRows = [makeRisk('RX-A'), makeRisk('RX-B'), makeRisk('RX-C')];
    const vantaRows = [{ riskId: 'RX-A', riskScenarioId: 'mongo-a' }];
    const client = makeStubClient({ vantaRows });
    const stats = await rrs({
      loadRisks: () => ({ data: sourceRows }),
      vantaClient: client
    });
    assert.strictEqual(stats.created, 2);
    assert.strictEqual(stats.updated, 1);
    assert.strictEqual(client.calls.patch[0].path, '/v1/risk-scenarios/mongo-a');
  });

  test('PATCH body excludes riskId (forCreate: false)', async () => {
    const sourceRows = [makeRisk('RX-A')];
    const vantaRows = [{ riskId: 'RX-A', riskScenarioId: 'mongo-a' }];
    const client = makeStubClient({ vantaRows });
    await rrs({
      loadRisks: () => ({ data: sourceRows }),
      vantaClient: client
    });
    assert.ok(!('riskId' in client.calls.patch[0].body));
  });

  test('stale in Vanta → counted in stats, no DELETE call', async () => {
    const sourceRows = [makeRisk('RX-A')];
    const vantaRows = [
      { riskId: 'RX-A', riskScenarioId: 'mongo-a' },
      { riskId: 'RX-DEAD', riskScenarioId: 'mongo-dead' }
    ];
    const client = makeStubClient({ vantaRows });
    const stats = await rrs({
      loadRisks: () => ({ data: sourceRows }),
      vantaClient: client
    });
    assert.strictEqual(stats.staleInVanta, 1);
  });

  test('POST error → counted but loop continues; other rows still created', async () => {
    const sourceRows = [makeRisk('RX-FAIL'), makeRisk('RX-OK')];
    const client = makeStubClient({
      vantaRows: [],
      postBehavior: (_path, body) => {
        if (body.riskId === 'RX-FAIL') throw new Error('simulated POST 400');
        return { ok: true };
      }
    });
    const stats = await rrs({
      loadRisks: () => ({ data: sourceRows }),
      vantaClient: client
    });
    assert.strictEqual(stats.created, 1);
    assert.strictEqual(stats.errors, 1);
    assert.strictEqual(stats.errorDetails[0].riskId, 'RX-FAIL');
    assert.strictEqual(stats.errorDetails[0].op, 'create');
  });

  test('PATCH error → counted with riskScenarioId attached for triage', async () => {
    const sourceRows = [makeRisk('RX-A')];
    const vantaRows = [{ riskId: 'RX-A', riskScenarioId: 'mongo-a' }];
    const client = makeStubClient({
      vantaRows,
      patchBehavior: () => { throw new Error('simulated PATCH 422'); }
    });
    const stats = await rrs({
      loadRisks: () => ({ data: sourceRows }),
      vantaClient: client
    });
    assert.strictEqual(stats.updated, 0);
    assert.strictEqual(stats.errors, 1);
    assert.strictEqual(stats.errorDetails[0].op, 'update');
    assert.strictEqual(stats.errorDetails[0].riskScenarioId, 'mongo-a');
  });

  test('empty source + populated Vanta → all stale, no API writes', async () => {
    const vantaRows = [
      { riskId: 'RX-X', riskScenarioId: 'mongo-x' },
      { riskId: 'RX-Y', riskScenarioId: 'mongo-y' }
    ];
    const client = makeStubClient({ vantaRows });
    const stats = await rrs({
      loadRisks: () => ({ data: [] }),
      vantaClient: client
    });
    assert.strictEqual(stats.created, 0);
    assert.strictEqual(stats.updated, 0);
    assert.strictEqual(stats.staleInVanta, 2);
    assert.strictEqual(client.calls.post.length, 0);
    assert.strictEqual(client.calls.patch.length, 0);
  });

  test('riskRegister option propagates to every payload', async () => {
    const sourceRows = [makeRisk('RX-A'), makeRisk('RX-B')];
    const vantaRows = [{ riskId: 'RX-A', riskScenarioId: 'mongo-a' }];
    const client = makeStubClient({ vantaRows });
    await rrs({
      loadRisks: () => ({ data: sourceRows }),
      vantaClient: client,
      riskRegister: 'Enterprise'
    });
    assert.strictEqual(client.calls.post[0].body.riskRegister, 'Enterprise');
    assert.strictEqual(client.calls.patch[0].body.riskRegister, 'Enterprise');
  });

  test('owner preflight omits unknown owner on create and reports it in stats', async () => {
    const sourceRows = [makeRisk('RX-A', { ownerEmail: 'missing-owner@example.com' })];
    const client = makeStubClient({ vantaRows: [], peopleRows: [] });
    const stats = await rrs({
      loadRisks: () => ({ data: sourceRows }),
      vantaClient: client
    });
    assert.deepStrictEqual(stats.unknownOwnerEmails, ['missing-owner@example.com']);
    assert.ok(!('owner' in client.calls.post[0].body));
  });

  test('owner preflight clears unknown owner on update', async () => {
    const sourceRows = [makeRisk('RX-A', { ownerEmail: 'missing-owner@example.com' })];
    const vantaRows = [{ riskId: 'RX-A', riskScenarioId: 'mongo-a' }];
    const client = makeStubClient({ vantaRows, peopleRows: [] });
    const stats = await rrs({
      loadRisks: () => ({ data: sourceRows }),
      vantaClient: client
    });
    assert.deepStrictEqual(stats.unknownOwnerEmails, ['missing-owner@example.com']);
    assert.strictEqual(client.calls.patch[0].body.owner, null);
  });
});

describe('runRiskSync — riskRegister fail-fast', () => {
  function makeStubClient() {
    return {
      async fetchAllPages() { return []; },
      async post() { return { ok: true }; },
      async patch() { return { ok: true }; }
    };
  }

  test('rejects when no riskRegister option AND no env var', async () => {
    const original = process.env.VANTA_RISK_REGISTER;
    delete process.env.VANTA_RISK_REGISTER;
    try {
      await assert.rejects(
        runRiskSync({
          loadRisks: () => ({ data: [] }),
          vantaClient: makeStubClient()
        }),
        /VANTA_RISK_REGISTER must be set/
      );
    } finally {
      if (original !== undefined) process.env.VANTA_RISK_REGISTER = original;
    }
  });

  test('rejects when riskRegister is explicitly empty string', async () => {
    await assert.rejects(
      runRiskSync({
        loadRisks: () => ({ data: [] }),
        vantaClient: makeStubClient(),
        riskRegister: ''
      }),
      /VANTA_RISK_REGISTER must be set/
    );
  });

  test('fail-fast happens before any Vanta API call', async () => {
    let touched = false;
    const client = {
      async fetchAllPages() { touched = true; return []; },
      async post() { touched = true; return {}; },
      async patch() { touched = true; return {}; }
    };
    await assert.rejects(
      runRiskSync({
        loadRisks: () => ({ data: [] }),
        vantaClient: client,
        riskRegister: ''
      })
    );
    assert.strictEqual(touched, false);
  });
});
