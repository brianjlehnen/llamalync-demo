// Postman v2.1 collection → normalized Explorer presets.
//
// Runs in two contexts:
//   - Node (node:test) via require()
//   - Browser, after the dashboard inlines this file into its <script> block
//
// Single source of truth — keep this file dependency-free (no require/import).
// The CommonJS export is gated on typeof module so the same source works in
// the browser, where module is undefined and the functions just live at
// script-scope.
//
// Scope (intentional):
//   - Path normalization (Build's `/v1/...` and Manage's `/...` both → `/v1/<rest>`)
//   - Path variable extraction (`:foo` syntax + url.variable[])
//   - Query param extraction (defaults + descriptions)
//   - Header capture (display-only; UI does not let users edit headers)
//   - Raw JSON body capture (template only — `{{var}}` placeholders preserved verbatim)
//
// Out of scope:
//   - Postman environment substitution (`{{baseUrl}}`, `{{accountResourceId}}`, etc.)
//   - Pre-request / test scripts (event[])
//   - File-upload / formdata / urlencoded bodies (skipped with a reason)
//   - Auth blocks (LlamaLync owns auth)

function parsePostmanCollection(rawJson) {
  let collection;
  if (typeof rawJson === 'string') {
    try {
      collection = JSON.parse(rawJson);
    } catch (err) {
      return { presets: [], skipped: [], error: `Invalid JSON: ${err.message}` };
    }
  } else {
    collection = rawJson;
  }

  if (!collection || !Array.isArray(collection.item)) {
    return { presets: [], skipped: [], error: 'Not a valid Postman collection (missing item[])' };
  }

  const presets = [];
  const skipped = [];

  function walk(items, groupPath) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      if (Array.isArray(item.item)) {
        // Folder — recurse with appended group path
        walk(item.item, groupPath.concat(item.name || 'Unnamed folder'));
      } else if (item.request) {
        const result = normalizeRequest(item, groupPath);
        if (result.skipped) {
          skipped.push({
            name: item.name || 'Unnamed request',
            group: groupPath.join(' / '),
            reason: result.reason
          });
        } else {
          presets.push(result.preset);
        }
      }
    }
  }

  walk(collection.item, []);
  return { presets, skipped };
}

function normalizeRequest(item, groupPath) {
  const r = item.request;
  if (!r || typeof r !== 'object') {
    return { skipped: true, reason: 'No request object' };
  }

  // URL handling — Postman stores both `url.raw` and a structured `url.path[]`.
  // We use the structured form because it avoids us having to parse out
  // `{{baseUrl}}` and other env templating.
  const url = (typeof r.url === 'object' && r.url) || {};
  const pathArr = Array.isArray(url.path) ? url.path.filter(Boolean) : [];
  if (pathArr.length === 0) {
    return { skipped: true, reason: 'Missing or empty url.path' };
  }

  // Normalization: Build folder's URLs include `v1/` in the path; Manage folder's
  // URLs assume baseUrl already contains `/v1`. Strip a leading `v1`, then
  // always re-add it so the output is uniform.
  const cleanedPath = pathArr[0] === 'v1' ? pathArr.slice(1) : pathArr;
  const pathTemplate = '/v1/' + cleanedPath.join('/');

  const method = (r.method || 'GET').toUpperCase();

  // Skip OAuth token requests — LlamaLync owns auth, exposing this endpoint
  // through the Explorer would either confuse users or leak credentials.
  if (/^\/v1\/oauth/.test(pathTemplate) || /oauth\/token/.test(pathTemplate)) {
    return { skipped: true, reason: 'OAuth token endpoint handled internally by LlamaLync' };
  }

  // Path variables — Postman declares them in url.variable[]. Defensive: also
  // scan the path itself for `:foo` and `{{foo}}` refs in case the source is
  // hand-edited and didn't sync url.variable[].
  const declaredVars = (Array.isArray(url.variable) ? url.variable : [])
    .filter(v => v && v.key)
    .map(v => ({
      key: String(v.key),
      defaultValue: v.value != null ? String(v.value) : '',
      description: v.description ? String(v.description) : ''
    }));
  const declaredKeys = new Set(declaredVars.map(v => v.key));
  const colonRefs = (pathTemplate.match(/:[a-zA-Z_][a-zA-Z0-9_]*/g) || [])
    .map(s => s.slice(1));
  const templateRefs = (pathTemplate.match(/\{\{[^{}]+\}\}/g) || [])
    .map(s => s.slice(2, -2).trim())
    .filter(Boolean);
  const inPathRefs = colonRefs.concat(templateRefs);
  const pathVars = declaredVars.slice();
  for (const key of inPathRefs) {
    if (!declaredKeys.has(key)) {
      pathVars.push({ key, defaultValue: '', description: '' });
    }
  }

  // Query params — preserved with defaults; UI decides which to enable at send time.
  const queryParams = (Array.isArray(url.query) ? url.query : [])
    .filter(q => q && q.key)
    .map(q => ({
      key: String(q.key),
      defaultValue: q.value != null ? String(q.value) : '',
      description: q.description ? String(q.description) : '',
      enabledByDefault: !q.disabled
    }));

  // Headers — display only. We never let MVP users send arbitrary headers,
  // but knowing what the collection says (e.g. Accept, Content-Type) is useful.
  const headers = (Array.isArray(r.header) ? r.header : [])
    .filter(h => h && h.key && !h.disabled)
    .map(h => ({ key: String(h.key), value: h.value != null ? String(h.value) : '' }));

  // Body — only raw JSON-ish bodies are supported. formdata/urlencoded/file
  // bodies belong to upload-style endpoints we explicitly don't support yet.
  let body = null;
  if (r.body && typeof r.body === 'object' && r.body.mode) {
    if (r.body.mode === 'raw') {
      const lang = (r.body.options && r.body.options.raw && r.body.options.raw.language) || 'text';
      body = {
        mode: 'raw',
        template: typeof r.body.raw === 'string' ? r.body.raw : '',
        language: String(lang)
      };
    } else if (r.body.mode === 'formdata' || r.body.mode === 'urlencoded' || r.body.mode === 'file') {
      return { skipped: true, reason: `Unsupported body mode: ${r.body.mode}` };
    }
    // Other modes (graphql, etc.) fall through with body = null.
  }

  // App inference from the top-level folder. If the import comes from a
  // collection that doesn't follow Vanta's two-app layout, we leave app = null
  // and the UI surfaces a manual selector.
  const rootGroup = (groupPath[0] || '').toLowerCase();
  let app = null;
  if (rootGroup.indexOf('build integrations') !== -1) app = 'build';
  else if (rootGroup.indexOf('manage vanta') !== -1) app = 'manage';

  const id = groupPath.concat(item.name || 'Unnamed').join(' / ');

  return {
    skipped: false,
    preset: {
      id,
      group: groupPath.join(' / '),
      name: item.name || 'Unnamed request',
      app,
      method,
      pathTemplate,
      pathVars,
      queryParams,
      headers,
      body
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePostmanCollection, normalizeRequest };
}
