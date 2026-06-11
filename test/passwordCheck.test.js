const { describe, test } = require('node:test');
const assert = require('node:assert');

const { passwordsMatch } = require('../src/auth/passwordCheck');

describe('passwordsMatch — happy path', () => {
  test('exact match returns true', () => {
    assert.strictEqual(passwordsMatch('hunter2', 'hunter2'), true);
  });

  test('case-sensitive match', () => {
    assert.strictEqual(passwordsMatch('Hunter2', 'hunter2'), false);
  });

  test('whitespace is significant', () => {
    assert.strictEqual(passwordsMatch(' hunter2', 'hunter2'), false);
    assert.strictEqual(passwordsMatch('hunter2 ', 'hunter2'), false);
  });
});

describe('passwordsMatch — length mismatches do not throw (the original bug)', () => {
  // The prior code compared JS code-unit lengths first, then built UTF-8
  // buffers — a submitted password with a multi-byte char whose code-unit
  // length matched the expected's code-unit length would slip past the
  // length check and then crash timingSafeEqual with "Input buffers must
  // have the same byte length". Each of these MUST return false without
  // throwing.

  test('submitted with multi-byte char vs ASCII expected of same code-unit length', () => {
    // "ñe" — 2 code units, 3 UTF-8 bytes. "aa" — 2 code units, 2 UTF-8 bytes.
    // Old code: lenMatch passes (2 === 2), then timingSafeEqual throws.
    assert.doesNotThrow(() => passwordsMatch('ñe', 'aa'));
    assert.strictEqual(passwordsMatch('ñe', 'aa'), false);
  });

  test('submitted with emoji surrogate pair vs ASCII expected of same code-unit length', () => {
    // "🙂a" — 3 code units (surrogate pair + 'a'), 5 UTF-8 bytes.
    // "aaa" — 3 code units, 3 UTF-8 bytes. Same code-unit count, different bytes.
    assert.doesNotThrow(() => passwordsMatch('🙂a', 'aaa'));
    assert.strictEqual(passwordsMatch('🙂a', 'aaa'), false);
  });

  test('submitted shorter than expected does not throw', () => {
    assert.doesNotThrow(() => passwordsMatch('a', 'hunter2'));
    assert.strictEqual(passwordsMatch('a', 'hunter2'), false);
  });

  test('submitted longer than expected does not throw', () => {
    assert.doesNotThrow(() => passwordsMatch('hunter2-extra-chars', 'hunter2'));
    assert.strictEqual(passwordsMatch('hunter2-extra-chars', 'hunter2'), false);
  });

  test('submitted is matching-prefix longer than expected is rejected', () => {
    // After padding/truncation, byte content of submitted's first 7 bytes
    // matches expected. The byte-length check is what rejects this — if it
    // weren't present, the truncated buffer would match and we'd accept
    // any password starting with "hunter2".
    assert.strictEqual(passwordsMatch('hunter22', 'hunter2'), false);
    assert.strictEqual(passwordsMatch('hunter2hunter2', 'hunter2'), false);
  });
});

describe('passwordsMatch — UTF-8 expected password', () => {
  test('UTF-8 password matches itself', () => {
    assert.strictEqual(passwordsMatch('contraseña-2026', 'contraseña-2026'), true);
  });

  test('UTF-8 password mismatch returns false', () => {
    assert.strictEqual(passwordsMatch('contraseña-2026', 'contraseña-2025'), false);
  });

  test('emoji password matches itself', () => {
    assert.strictEqual(passwordsMatch('🦙sync🦙', '🦙sync🦙'), true);
  });
});

describe('passwordsMatch — degenerate inputs', () => {
  test('empty submitted returns false', () => {
    assert.strictEqual(passwordsMatch('', 'hunter2'), false);
  });

  test('empty expected returns false (caller should set a password)', () => {
    assert.strictEqual(passwordsMatch('anything', ''), false);
  });

  test('both empty returns false (no password = no auth)', () => {
    assert.strictEqual(passwordsMatch('', ''), false);
  });

  test('null submitted returns false (no throw)', () => {
    assert.doesNotThrow(() => passwordsMatch(null, 'hunter2'));
    assert.strictEqual(passwordsMatch(null, 'hunter2'), false);
  });

  test('undefined submitted returns false', () => {
    assert.strictEqual(passwordsMatch(undefined, 'hunter2'), false);
  });

  test('non-string submitted (number) returns false', () => {
    assert.strictEqual(passwordsMatch(12345, 'hunter2'), false);
  });

  test('non-string expected returns false', () => {
    assert.strictEqual(passwordsMatch('hunter2', null), false);
    assert.strictEqual(passwordsMatch('hunter2', undefined), false);
    assert.strictEqual(passwordsMatch('hunter2', 12345), false);
  });
});
