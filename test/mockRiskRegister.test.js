const { describe, test } = require('node:test');
const assert = require('node:assert');

const { diffAgainstVanta, RISK_CUSTOM_FIELDS } = require('../src/mockRiskRegister');

function src(internalId) {
  return { internalId, title: 't', description: 'd' };
}

describe('diffAgainstVanta', () => {
  test('empty Vanta → every source row goes to toCreate', () => {
    const result = diffAgainstVanta([src('A'), src('B'), src('C')], []);
    assert.strictEqual(result.toCreate.length, 3);
    assert.strictEqual(result.toUpdate.length, 0);
    assert.strictEqual(result.staleInVanta.length, 0);
  });

  test('empty source → every Vanta row is stale, no writes', () => {
    const vanta = [
      { riskId: 'A', riskScenarioId: 'mongo-a' },
      { riskId: 'B', riskScenarioId: 'mongo-b' }
    ];
    const result = diffAgainstVanta([], vanta);
    assert.strictEqual(result.toCreate.length, 0);
    assert.strictEqual(result.toUpdate.length, 0);
    assert.strictEqual(result.staleInVanta.length, 2);
  });

  test('perfect match → all toUpdate, none stale', () => {
    const source = [src('A'), src('B')];
    const vanta = [
      { riskId: 'A', riskScenarioId: 'mongo-a' },
      { riskId: 'B', riskScenarioId: 'mongo-b' }
    ];
    const result = diffAgainstVanta(source, vanta);
    assert.strictEqual(result.toCreate.length, 0);
    assert.strictEqual(result.toUpdate.length, 2);
    assert.strictEqual(result.staleInVanta.length, 0);
  });

  test('mixed state → correct split', () => {
    const source = [src('A'), src('B'), src('C')];
    const vanta = [
      { riskId: 'A', riskScenarioId: 'mongo-a' },
      { riskId: 'DEAD', riskScenarioId: 'mongo-dead' }
    ];
    const result = diffAgainstVanta(source, vanta);
    assert.strictEqual(result.toCreate.length, 2); // B, C
    assert.strictEqual(result.toUpdate.length, 1); // A
    assert.strictEqual(result.staleInVanta.length, 1); // DEAD
    assert.strictEqual(result.staleInVanta[0].riskId, 'DEAD');
  });

  test('toUpdate items surface riskScenarioId for PATCH targeting', () => {
    const source = [src('A')];
    const vanta = [{ riskId: 'A', riskScenarioId: 'mongo-aaa' }];
    const result = diffAgainstVanta(source, vanta);
    assert.strictEqual(result.toUpdate[0].riskScenarioId, 'mongo-aaa');
    assert.strictEqual(result.toUpdate[0].source.internalId, 'A');
  });

  test('Mongo-style id field on Vanta record also accepted (riskScenarioId missing)', () => {
    // Defensive: the read endpoint shape isn't fully verified. The diff
    // helper looks at riskScenarioId, then id, then falls back to riskId.
    const source = [src('A')];
    const vanta = [{ riskId: 'A', id: 'alt-id' }];
    const result = diffAgainstVanta(source, vanta);
    assert.strictEqual(result.toUpdate[0].riskScenarioId, 'alt-id');
  });

  test('Vanta record without riskId field is ignored for matching', () => {
    // Some risk scenarios may have been created in the UI without a
    // customer-supplied riskId. We cannot match those to a source row, so
    // they are neither stale nor toUpdate — just invisible to the diff.
    const source = [src('A')];
    const vanta = [
      { riskId: 'A', riskScenarioId: 'mongo-a' },
      { riskScenarioId: 'mongo-orphan' /* no riskId */ }
    ];
    const result = diffAgainstVanta(source, vanta);
    assert.strictEqual(result.toUpdate.length, 1);
    assert.strictEqual(result.staleInVanta.length, 0);
  });
});

describe('RISK_CUSTOM_FIELDS contract', () => {
  test('is frozen — labels cannot be mutated at runtime', () => {
    assert.strictEqual(Object.isFrozen(RISK_CUSTOM_FIELDS), true);
  });

  test('exposes the four locked labels', () => {
    assert.strictEqual(RISK_CUSTOM_FIELDS.SOURCE_ID, 'Source Risk-X ID');
    assert.strictEqual(RISK_CUSTOM_FIELDS.SOURCE_STATUS, 'Source Status');
    assert.strictEqual(RISK_CUSTOM_FIELDS.SOURCE_CONTROL_IDS, 'Source Control IDs');
    assert.strictEqual(RISK_CUSTOM_FIELDS.SOURCE_LAST_REVIEWED, 'Source Last Reviewed');
  });
});
