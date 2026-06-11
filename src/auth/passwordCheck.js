const crypto = require('crypto');

/**
 * Constant-time password comparison that handles UTF-8 multi-byte input.
 *
 * The prior implementation in src/index.js compared
 *   `submitted.length === expectedPassword.length`
 * — JS string lengths in UTF-16 code units — and then built buffers via
 * `Buffer.from(str)` which uses UTF-8 bytes. A submitted password
 * containing a multi-byte character whose UTF-16 code-unit length happened
 * to equal the expected string's code-unit length produces UTF-8 buffers
 * of *different* byte length, and `crypto.timingSafeEqual` throws on
 * length-mismatched buffers — 500 to the user instead of a clean 401.
 *
 * Implementation:
 *   1. Encode both as UTF-8 buffers.
 *   2. Pad submitted to expected length so `timingSafeEqual` never throws.
 *   3. AND the byte-comparison with an explicit byte-length check so a
 *      longer submitted-with-matching-prefix isn't accepted.
 *
 * Returns false on any malformed input (non-string, empty expected). The
 * caller's wrong-password path handles false the same way it would handle
 * a normal mismatch.
 */
function passwordsMatch(submitted, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const submittedStr = typeof submitted === 'string' ? submitted : '';

  const expectedBuf  = Buffer.from(expected,     'utf8');
  const submittedBuf = Buffer.from(submittedStr, 'utf8');

  // Pad to expected length so timingSafeEqual sees equal-length buffers.
  // A submitted buffer longer than expected is truncated; the explicit
  // byte-length check below catches that case.
  const padded = Buffer.alloc(expectedBuf.length);
  submittedBuf.copy(padded, 0, 0, Math.min(submittedBuf.length, expectedBuf.length));

  const bytesMatch = crypto.timingSafeEqual(padded, expectedBuf);
  const lenMatch   = submittedBuf.length === expectedBuf.length;
  return bytesMatch && lenMatch;
}

module.exports = { passwordsMatch };
