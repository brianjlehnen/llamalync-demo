const { describe, test } = require('node:test');
const assert = require('node:assert');

const { parsePostmanCollection } = require('../src/dashboard/explorer/postmanImport');

// Helpers to build a request leaf and a folder, so the fixture stays readable.
function req(name, request) {
  return { name, request };
}
function folder(name, items) {
  return { name, item: items };
}

describe('parsePostmanCollection — input validation', () => {
  test('rejects malformed JSON string', () => {
    const result = parsePostmanCollection('{not json');
    assert.match(result.error, /Invalid JSON/);
    assert.deepStrictEqual(result.presets, []);
    assert.deepStrictEqual(result.skipped, []);
  });

  test('rejects non-collection objects', () => {
    const result = parsePostmanCollection({ foo: 'bar' });
    assert.match(result.error, /not a valid Postman collection/i);
  });

  test('handles empty collection', () => {
    const result = parsePostmanCollection({ item: [] });
    assert.deepStrictEqual(result.presets, []);
    assert.deepStrictEqual(result.skipped, []);
  });

  test('accepts a JSON string of a valid collection', () => {
    const json = JSON.stringify({
      info: { name: 'test' },
      item: [folder('Manage Vanta', [
        req('List controls', {
          method: 'GET',
          url: { path: ['controls'] }
        })
      ])]
    });
    const result = parsePostmanCollection(json);
    assert.strictEqual(result.presets.length, 1);
  });
});

describe('parsePostmanCollection — path normalization', () => {
  test('Build paths starting with "v1" are not double-prefixed', () => {
    const result = parsePostmanCollection({
      item: [folder('Build Integrations', [
        req('Get user accounts', {
          method: 'GET',
          url: { path: ['v1', 'resources', 'user_account'] }
        })
      ])]
    });
    assert.strictEqual(result.presets[0].pathTemplate, '/v1/resources/user_account');
  });

  test('Manage paths without "v1" get prepended', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('List controls', {
          method: 'GET',
          url: { path: ['controls'] }
        })
      ])]
    });
    assert.strictEqual(result.presets[0].pathTemplate, '/v1/controls');
  });

  test('multi-segment Manage path normalizes correctly', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('Get framework controls', {
          method: 'GET',
          url: { path: ['frameworks', ':frameworkId', 'controls'] }
        })
      ])]
    });
    assert.strictEqual(result.presets[0].pathTemplate, '/v1/frameworks/:frameworkId/controls');
  });

  test('skips request with empty path', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('Bad', { method: 'GET', url: { path: [] } })
      ])]
    });
    assert.strictEqual(result.presets.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /url\.path/i);
  });
});

describe('parsePostmanCollection — path variables', () => {
  test('extracts vars from url.variable[]', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('Get person', {
          method: 'GET',
          url: {
            path: ['people', ':personId'],
            variable: [{ key: 'personId', value: 'demo-1' }]
          }
        })
      ])]
    });
    assert.deepStrictEqual(result.presets[0].pathVars, [
      { key: 'personId', defaultValue: 'demo-1', description: '' }
    ]);
  });

  test('detects vars from path even when url.variable[] is missing', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('Get person', {
          method: 'GET',
          url: { path: ['people', ':personId'] }
        })
      ])]
    });
    assert.deepStrictEqual(result.presets[0].pathVars, [
      { key: 'personId', defaultValue: '', description: '' }
    ]);
  });

  test('detects templated vars from path even when url.variable[] is missing', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('Get person', {
          method: 'GET',
          url: { path: ['people', '{{personId}}'] }
        })
      ])]
    });
    assert.strictEqual(result.presets[0].pathTemplate, '/v1/people/{{personId}}');
    assert.deepStrictEqual(result.presets[0].pathVars, [
      { key: 'personId', defaultValue: '', description: '' }
    ]);
  });

  test('does not duplicate vars declared in both', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('Get test entity', {
          method: 'GET',
          url: {
            path: ['tests', ':testId', 'entities', ':entityId'],
            variable: [
              { key: 'testId', value: 't1' },
              { key: 'entityId', value: 'e1' }
            ]
          }
        })
      ])]
    });
    const keys = result.presets[0].pathVars.map(v => v.key);
    assert.deepStrictEqual(keys, ['testId', 'entityId']);
  });
});

describe('parsePostmanCollection — query params', () => {
  test('preserves keys, defaults, and enabledByDefault', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('List people', {
          method: 'GET',
          url: {
            path: ['people'],
            query: [
              { key: 'pageSize', value: '10' },
              { key: 'pageCursor', value: 'abc', disabled: true }
            ]
          }
        })
      ])]
    });
    const params = result.presets[0].queryParams;
    assert.strictEqual(params.length, 2);
    assert.deepStrictEqual(params[0], {
      key: 'pageSize',
      defaultValue: '10',
      description: '',
      enabledByDefault: true
    });
    assert.strictEqual(params[1].enabledByDefault, false);
  });
});

describe('parsePostmanCollection — body handling', () => {
  test('captures raw JSON body verbatim', () => {
    const result = parsePostmanCollection({
      item: [folder('Build Integrations', [
        req('Sync user accounts', {
          method: 'PUT',
          url: { path: ['v1', 'resources', 'user_account'] },
          body: {
            mode: 'raw',
            raw: '{\n  "resourceId": "{{accountResourceId}}"\n}',
            options: { raw: { language: 'json' } }
          }
        })
      ])]
    });
    assert.deepStrictEqual(result.presets[0].body, {
      mode: 'raw',
      template: '{\n  "resourceId": "{{accountResourceId}}"\n}',
      language: 'json'
    });
  });

  test('skips formdata bodies with a reason', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('Upload document', {
          method: 'POST',
          url: { path: ['documents', ':documentId', 'uploads'] },
          body: { mode: 'formdata', formdata: [] }
        })
      ])]
    });
    assert.strictEqual(result.presets.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /formdata/);
  });

  test('skips urlencoded and file body modes too', () => {
    const result = parsePostmanCollection({
      item: [
        folder('Build Integrations', [
          req('Form', { method: 'POST', url: { path: ['x'] }, body: { mode: 'urlencoded' } }),
          req('File', { method: 'POST', url: { path: ['y'] }, body: { mode: 'file' } })
        ])
      ]
    });
    assert.strictEqual(result.skipped.length, 2);
  });
});

describe('parsePostmanCollection — headers (display-only)', () => {
  test('captures Accept and Content-Type', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('Create control', {
          method: 'POST',
          url: { path: ['controls'] },
          header: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'Accept', value: 'application/json' }
          ]
        })
      ])]
    });
    assert.strictEqual(result.presets[0].headers.length, 2);
  });

  test('drops disabled headers', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('R', {
          method: 'GET',
          url: { path: ['x'] },
          header: [
            { key: 'X-Test', value: 'a', disabled: true },
            { key: 'Accept', value: 'application/json' }
          ]
        })
      ])]
    });
    assert.strictEqual(result.presets[0].headers.length, 1);
    assert.strictEqual(result.presets[0].headers[0].key, 'Accept');
  });
});

describe('parsePostmanCollection — app inference', () => {
  test('Build Integrations folder → app: "build"', () => {
    const result = parsePostmanCollection({
      item: [folder('Build Integrations', [
        req('R', { method: 'GET', url: { path: ['v1', 'resources', 'user_account'] } })
      ])]
    });
    assert.strictEqual(result.presets[0].app, 'build');
  });

  test('Manage Vanta folder → app: "manage"', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        req('R', { method: 'GET', url: { path: ['controls'] } })
      ])]
    });
    assert.strictEqual(result.presets[0].app, 'manage');
  });

  test('unrecognized root folder → app: null (UI selects manually)', () => {
    const result = parsePostmanCollection({
      item: [folder('Custom Workspace', [
        req('R', { method: 'GET', url: { path: ['something'] } })
      ])]
    });
    assert.strictEqual(result.presets[0].app, null);
  });
});

describe('parsePostmanCollection — folder nesting + group path', () => {
  test('flattens nested folders into group path', () => {
    const result = parsePostmanCollection({
      item: [folder('Manage Vanta', [
        folder('controls', [
          folder(':controlId', [
            req('Get control by ID', {
              method: 'GET',
              url: {
                path: ['controls', ':controlId'],
                variable: [{ key: 'controlId', value: 'string' }]
              }
            })
          ])
        ])
      ])]
    });
    assert.strictEqual(result.presets[0].group, 'Manage Vanta / controls / :controlId');
    assert.strictEqual(result.presets[0].name, 'Get control by ID');
  });
});

describe('parsePostmanCollection — OAuth skip', () => {
  test('OAuth token endpoint is skipped', () => {
    const result = parsePostmanCollection({
      item: [folder('Build Integrations', [
        folder('Authentication', [
          req('Create Token', {
            method: 'POST',
            url: { path: ['oauth', 'token'] }
          })
        ])
      ])]
    });
    assert.strictEqual(result.presets.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /OAuth/);
  });
});

describe('parsePostmanCollection — combined real-shape sample', () => {
  test('parses a representative subset of the actual Vanta collection', () => {
    const result = parsePostmanCollection({
      item: [
        folder('Build Integrations', [
          folder('Authentication', [
            req('Create Token', {
              method: 'POST',
              url: { path: ['oauth', 'token'] }
            })
          ]),
          folder('Account Resource Type', [
            req('Get User Accounts', {
              method: 'GET',
              url: {
                path: ['v1', 'resources', 'user_account'],
                query: [{ key: 'resourceId', value: '{{accountResourceId}}' }]
              }
            }),
            req('Sync User Accounts', {
              method: 'PUT',
              url: { path: ['v1', 'resources', 'user_account'] },
              header: [{ key: 'content-type', value: 'application/json' }],
              body: {
                mode: 'raw',
                raw: '{ "resourceId": "{{accountResourceId}}" }',
                options: { raw: { language: 'json' } }
              }
            })
          ])
        ]),
        folder('Manage Vanta', [
          folder('controls', [
            req('List controls', {
              method: 'GET',
              url: {
                path: ['controls'],
                query: [{ key: 'pageSize', value: '10' }]
              }
            }),
            folder(':controlId', [
              req('Get control by ID', {
                method: 'GET',
                url: {
                  path: ['controls', ':controlId'],
                  variable: [{ key: 'controlId', value: 'string' }]
                }
              })
            ])
          ]),
          folder('documents', [
            req('Upload', {
              method: 'POST',
              url: { path: ['documents', ':documentId', 'uploads'] },
              body: { mode: 'formdata' }
            })
          ])
        ])
      ]
    });

    // Expected: 2 build (token skipped), 2 manage list/by-id, 1 formdata skipped
    assert.strictEqual(result.presets.length, 4);
    assert.strictEqual(result.skipped.length, 2);

    const byName = Object.fromEntries(result.presets.map(p => [p.name, p]));
    assert.strictEqual(byName['Get User Accounts'].app, 'build');
    assert.strictEqual(byName['Get User Accounts'].pathTemplate, '/v1/resources/user_account');
    assert.strictEqual(byName['Sync User Accounts'].method, 'PUT');
    assert.strictEqual(byName['Sync User Accounts'].body.language, 'json');
    assert.strictEqual(byName['List controls'].app, 'manage');
    assert.strictEqual(byName['List controls'].pathTemplate, '/v1/controls');
    assert.strictEqual(byName['Get control by ID'].pathVars[0].key, 'controlId');

    const skippedReasons = result.skipped.map(s => s.reason).join(' | ');
    assert.match(skippedReasons, /OAuth/);
    assert.match(skippedReasons, /formdata/);
  });
});
