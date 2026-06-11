const { describe, test } = require('node:test');
const assert = require('node:assert');

const { safeHref, escapeHtml, explorerPathHasTraversal } = require('../src/dashboard');

describe('safeHref — accepts plain http(s) URLs', () => {
  test('https URL passes through escaped', () => {
    assert.strictEqual(
      safeHref('https://app.vanta.com/integrations/123'),
      'https://app.vanta.com/integrations/123'
    );
  });

  test('http URL passes through escaped', () => {
    assert.strictEqual(safeHref('http://example.com/x'), 'http://example.com/x');
  });

  test('mixed-case scheme is accepted (HTTPS, HtTp)', () => {
    assert.strictEqual(safeHref('HTTPS://example.com'), 'HTTPS://example.com');
    assert.strictEqual(safeHref('HtTp://example.com'), 'HtTp://example.com');
  });

  test('URL with HTML metacharacters is escaped (& and quote)', () => {
    assert.strictEqual(
      safeHref('https://example.com/?a=1&b="x"'),
      'https://example.com/?a=1&amp;b=&quot;x&quot;'
    );
  });
});

describe('safeHref — rejects non-http(s) schemes (the XSS hole)', () => {
  test('javascript: scheme returns empty', () => {
    assert.strictEqual(safeHref('javascript:alert(1)'), '');
  });

  test('JavaScript: with mixed case still rejected', () => {
    assert.strictEqual(safeHref('JaVaScRiPt:alert(1)'), '');
  });

  test('data: scheme rejected', () => {
    assert.strictEqual(safeHref('data:text/html,<script>alert(1)</script>'), '');
  });

  test('vbscript: scheme rejected', () => {
    assert.strictEqual(safeHref('vbscript:msgbox(1)'), '');
  });

  test('file: scheme rejected', () => {
    assert.strictEqual(safeHref('file:///etc/passwd'), '');
  });

  test('mailto: rejected (not a web URL)', () => {
    assert.strictEqual(safeHref('mailto:x@y.com'), '');
  });

  test('protocol-relative // rejected (no scheme on input)', () => {
    // Browsers resolve `//evil.com` against the page's protocol. We
    // explicitly require absolute http(s) so the scheme is unambiguous.
    assert.strictEqual(safeHref('//evil.com/x'), '');
  });

  test('relative path rejected (links inside the dashboard build their own paths)', () => {
    assert.strictEqual(safeHref('/dashboard/foo'), '');
  });
});

describe('safeHref — whitespace and trim defenses', () => {
  test('leading whitespace before javascript: is stripped and rejected', () => {
    // Browsers strip leading whitespace before parsing the scheme, so
    // " javascript:alert(1)" is treated as javascript:. The trim before
    // scheme-check is the load-bearing defense against that.
    assert.strictEqual(safeHref(' javascript:alert(1)'), '');
    assert.strictEqual(safeHref('\tjavascript:alert(1)'), '');
    assert.strictEqual(safeHref('\njavascript:alert(1)'), '');
  });

  test('leading whitespace before https: is trimmed and accepted', () => {
    assert.strictEqual(safeHref('  https://example.com  '), 'https://example.com');
  });
});

describe('safeHref — degenerate inputs', () => {
  test('null returns empty', () => {
    assert.strictEqual(safeHref(null), '');
  });

  test('undefined returns empty', () => {
    assert.strictEqual(safeHref(undefined), '');
  });

  test('empty string returns empty', () => {
    assert.strictEqual(safeHref(''), '');
  });

  test('non-string (number) returns empty', () => {
    assert.strictEqual(safeHref(12345), '');
  });

  test('non-string (object) returns empty', () => {
    assert.strictEqual(safeHref({ href: 'https://x.com' }), '');
  });
});

describe('escapeHtml — sanity (used by safeHref and elsewhere)', () => {
  test('escapes the five HTML-significant characters', () => {
    assert.strictEqual(
      escapeHtml(`<a href="x" onclick='y'>&amp;</a>`),
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;'
    );
  });

  test('null/undefined return empty string', () => {
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
  });
});

describe('explorerPathHasTraversal — accepts legitimate paths', () => {
  test('plain /v1/{collection} path is allowed', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/people'), false);
  });

  test('path with query string is allowed', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/people?pageSize=100'), false);
  });

  test('path with multiple segments and dots in filenames is allowed', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/resources/MacosUserComputer'), false);
    assert.strictEqual(explorerPathHasTraversal('/v1/documents/access-review-2026-Q1.csv'), false);
  });

  test('three-dot segment is not a traversal (only literal `..` matches)', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/.../foo'), false);
  });

  test('`..` inside a query value is allowed (not a path segment)', () => {
    // The regex anchors `..` to slash/start/end/`?` boundaries, so a value
    // like `?filter=..bar` is not flagged. Practical: customers might
    // legitimately filter on strings containing `..`.
    assert.strictEqual(explorerPathHasTraversal('/v1/people?filter=..bar'), false);
  });
});

describe('explorerPathHasTraversal — rejects path-traversal patterns (the original bug)', () => {
  test('`/v1/../foo` rejected — would collapse to `/foo` once joined to base URL', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/../foo'), true);
  });

  test('`/v1/foo/../bar` rejected (mid-path traversal)', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/foo/../bar'), true);
  });

  test('trailing `/..` rejected', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/foo/..'), true);
  });

  test('`/..` immediately before query string rejected', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/foo/..?q=x'), true);
  });

  test('multiple traversal segments rejected', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/../../etc'), true);
  });
});

describe('explorerPathHasTraversal — rejects encoded / disguised variants', () => {
  test('URL-encoded `..` rejected (`%2e%2e`)', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/%2e%2e/foo'), true);
  });

  test('uppercase URL-encoded `..` rejected (`%2E%2E`)', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/%2E%2E/foo'), true);
  });

  test('backslash rejected (Windows-style separator confuses intermediaries)', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/foo\\bar'), true);
  });

  test('mixed slash+backslash rejected', () => {
    assert.strictEqual(explorerPathHasTraversal('/v1/foo/..\\bar'), true);
  });
});

describe('explorerPathHasTraversal — degenerate inputs', () => {
  test('non-string returns true (treat as suspect)', () => {
    assert.strictEqual(explorerPathHasTraversal(null), true);
    assert.strictEqual(explorerPathHasTraversal(undefined), true);
    assert.strictEqual(explorerPathHasTraversal(123), true);
    assert.strictEqual(explorerPathHasTraversal({}), true);
  });

  test('empty string returns false (caller separately rejects via prefix check)', () => {
    assert.strictEqual(explorerPathHasTraversal(''), false);
  });
});

