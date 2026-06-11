const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { safeLoadJson } = require('../src/utils/safeLoadJson');

let tmpDir;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeLoadJson-')); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeFixture(name, contents) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, contents, 'utf-8');
  return p;
}

describe('safeLoadJson — happy path', () => {
  test('valid JSON object parses normally', () => {
    const p = writeFixture('object.json', '{"a":1,"b":"two"}');
    assert.deepStrictEqual(safeLoadJson(p), { a: 1, b: 'two' });
  });

  test('valid JSON array parses normally', () => {
    const p = writeFixture('array.json', '[1,2,3]');
    assert.deepStrictEqual(safeLoadJson(p), [1, 2, 3]);
  });

  test('empty array parses to []', () => {
    const p = writeFixture('empty-array.json', '[]');
    assert.deepStrictEqual(safeLoadJson(p), []);
  });
});

describe('safeLoadJson — malformed JSON gets file context in the error', () => {
  test('truncated object throws Error mentioning the file path', () => {
    // Mid-edit save: closing brace missing.
    const p = writeFixture('truncated.json', '{"a":1,"b":');
    assert.throws(
      () => safeLoadJson(p),
      err => err.message.includes('Invalid JSON in') && err.message.includes(p)
    );
  });

  test('unexpected token error gets wrapped with file context', () => {
    const p = writeFixture('trailing-comma.json', '{"a":1,}');
    assert.throws(
      () => safeLoadJson(p),
      err => err.message.includes('Invalid JSON in') && err.message.includes('trailing-comma.json')
    );
  });

  test('empty file throws with file context (not a silent {})', () => {
    const p = writeFixture('empty.json', '');
    assert.throws(
      () => safeLoadJson(p),
      err => err.message.includes('Invalid JSON in') && err.message.includes('empty.json')
    );
  });

  test('non-JSON content (just text) throws with file context', () => {
    const p = writeFixture('plaintext.json', 'this is not json');
    assert.throws(
      () => safeLoadJson(p),
      /Invalid JSON in/
    );
  });
});

describe('safeLoadJson — non-existent file', () => {
  test('throws the underlying ENOENT (already clear, no double-wrap)', () => {
    const p = path.join(tmpDir, 'does-not-exist.json');
    assert.throws(
      () => safeLoadJson(p),
      err => /ENOENT/.test(err.message) || /no such file/i.test(err.message)
    );
  });
});
