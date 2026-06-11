const fs = require('fs');

/**
 * Read + parse a JSON file, throwing a clearly-contextualized error if the
 * contents aren't valid JSON.
 *
 * The mock loaders (mockHris, mockCmdb, mockRiskRegister, mockEvidenceStore)
 * previously did a bare `JSON.parse(fs.readFileSync(file, 'utf-8'))`. A
 * mid-edit save of a mock JSON file would produce `SyntaxError: Unexpected
 * token } at position 142` with no indication of WHICH file is broken —
 * a 500 to the dashboard with an opaque message.
 *
 * Wrapping the parse step lets the operator running locally see exactly
 * which file to fix. The fs read itself already produces a clear ENOENT-style
 * error so we don't double-wrap.
 */
function safeLoadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

module.exports = { safeLoadJson };
