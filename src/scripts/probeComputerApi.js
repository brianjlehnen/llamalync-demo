/**
 * Surgical probe of Vanta's Build Integrations `computer`-family resource
 * schema(s).
 *
 * Open questions (from the approved GAP 1 plan, post-amendment):
 *
 *   Q1  Is "computer" a single generic resource type or are there distinct
 *       platform-specific types (e.g. MacOS UserComputer, Windows UserComputer)?
 *   Q2  What are the required fields per type? POST minimal, iterate 400s.
 *   Q3  What's the rejected-field set? POST maximalist, capture every extra.
 *   Q4  Owner linkage shape — `ownerEmail` (resolves to People), or
 *       `externalOwnerEmployeeId` (cross-system link), or both?
 *   Q5  Linux Go/No-Go — is Linux supported as a native computer resource at
 *       all? If not, the implementation must pick one of three explicit paths:
 *         (a) drop Linux from the Vanta push
 *         (b) map Linux to a custom resource type
 *         (c) surface Linux devices as an "unsupported source row" in the
 *             dashboard — the strongest SA demo moment per reviewer note
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Setup before running this probe
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. Open Vanta Developer Console → LlamaLync Sync (Build Integrations app)
 *    → Resources tab → "+ Create Resource".
 * 2. Inspect the "Base Resource Type" dropdown. Note every option that looks
 *    computer-related. For each such option, create one Resource (give it a
 *    distinct name like "Probe MacOS UserComputer").
 * 3. For each created Resource, capture:
 *      • the Resource ID Vanta assigns (24-char hex or slug)
 *      • the exact base-type name shown in the dropdown (this becomes the
 *        path segment in PUT /v1/resources/{type})
 * 4. Set the env vars below. Any combination can be left blank — the probe
 *    skips platforms with no Resource ID and reports them as "not probed."
 *
 *    VANTA_PROBE_MACOS_RESOURCE_ID
 *    VANTA_PROBE_MACOS_RESOURCE_TYPE        e.g. "macos_user_computer"
 *    VANTA_PROBE_WINDOWS_RESOURCE_ID
 *    VANTA_PROBE_WINDOWS_RESOURCE_TYPE      e.g. "windows_user_computer"
 *    VANTA_PROBE_LINUX_RESOURCE_ID          (leave blank if no Linux dropdown option)
 *    VANTA_PROBE_LINUX_RESOURCE_TYPE
 *
 * 5. If the Dev Console dropdown has NO Linux option, that itself answers Q5:
 *    leave the LINUX_* vars blank and the probe reports Linux as natively
 *    unsupported.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What this probe will write to your tenant
 * ─────────────────────────────────────────────────────────────────────────
 *
 * For each platform probed, the script PUTs synthetic records prefixed with
 * `LLAMALYNC-PROBE-{YYYYMMDD-HHMM}-` against the Resource ID you provided.
 * PUT semantics are full-snapshot — the FINAL PUT in each platform's probe
 * sequence sends `resources: []`, which soft-deletes the probe records.
 * Anything that survives can be cleaned up by manually issuing one more PUT
 * with an empty resources array, or by deleting the Resource definition in
 * Dev Console.
 *
 * Run: `node src/scripts/probeComputerApi.js`
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { buildClient } = require('../http/vantaClient');

// ─── Helpers (shape mirrors probeRiskApi.js) ─────────────────────────────────

function timestampSuffix() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hm = now.toTimeString().slice(0, 5).replace(':', '');
  return `${ymd}-${hm}`;
}

function shortJson(value, max = 1500) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return s && s.length > max ? s.slice(0, max) + '\n... [truncated]' : s;
}

async function probe(label, fn) {
  console.log('');
  console.log('═══ ' + label + ' ═══');
  try {
    const result = await fn();
    console.log('OK · response body:');
    console.log(shortJson(result));
    return { ok: true, result };
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.log(`ERROR · status=${status}`);
    console.log('body:');
    console.log(shortJson(body));
    return { ok: false, status, body, message: err.message };
  }
}

// buildClient.put() resolves with response data, not the full axios response
// object, so probes that succeed have no HTTP status to surface. Render an
// explicit "OK" rather than "status=undefined" in the summary lines.
function statusLabel(r) {
  return r.ok ? 'OK' : `status=${r.status}`;
}

/**
 * Pull the field-name list out of a Vanta 400 error. Vanta's error idioms
 * vary across resource types; we look for the patterns the user_account
 * probe surfaced in build-log.md plus the Computer-resource idioms surfaced
 * in the 2026-05-13 first-pass probe:
 *   - "must have property 'X'"               → required field (Computer + user_account)
 *   - "Too many fields ... Extra keys: A, B" → rejected fields (user_account)
 *   - "/0/X: must NOT have additional propert(y|ies)" → JSON-Schema rejection idiom
 *   - "/0/X: must be type 'Y'"               → type-mismatch on already-supplied field
 */
function parseMissingFields(body) {
  if (!body) return [];
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const matches = text.match(/must have property ['"]([^'"]+)['"]/g) || [];
  return matches.map(m => m.match(/property ['"]([^'"]+)['"]/)[1]);
}

function parseExtraFields(body) {
  if (!body) return [];
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  // Pattern 1: "Extra keys: A, B" (user_account idiom)
  const m1 = text.match(/Extra keys?:\s*([^.}]+)/i);
  if (m1) return m1[1].split(/[,\s]+/).filter(Boolean);
  // Pattern 2: "/0/foo: must NOT have additional propert..." (JSON-Schema idiom)
  const m2 = [...text.matchAll(/\/0\/(\w+):\s*must NOT have additional propert/gi)];
  if (m2.length) return m2.map(m => m[1]);
  // Pattern 3: "Unknown field: X" / "Unrecognized field: X"
  const m3 = [...text.matchAll(/(?:Unknown|Unrecognized)\s+field:?\s*['"]?(\w+)['"]?/gi)];
  if (m3.length) return m3.map(m => m[1]);
  return [];
}

/**
 * Parse type-mismatch errors so the discovery loop can adapt placeholders
 * (e.g. swap a string for a boolean / array) instead of stalling. Two idioms:
 *   - "/0/X: must be type 'Y'"   — user_account idiom (quoted, with "type" keyword)
 *   - "/0/X: must be Y"          — Computer-resource idiom (bare-word; 2026-05-13
 *                                   probe finding: "/0/applications: must be array")
 */
function parseTypeErrors(body) {
  if (!body) return [];
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const out = [];
  for (const m of text.matchAll(/\/0\/(\w+):\s*must be type ['"](\w+)['"]/g)) {
    out.push({ field: m[1], expectedType: m[2] });
  }
  for (const m of text.matchAll(/\/0\/(\w+):\s*must be (array|object|boolean|integer|number|string|null)\b/g)) {
    out.push({ field: m[1], expectedType: m[2] });
  }
  return out;
}

/**
 * Produce a placeholder value for a field whose name we know but whose
 * full schema we don't. Picks a type based on the requested type (when the
 * validator told us via a type-error) or on heuristic name patterns.
 */
function typedPlaceholder(fieldName, expectedType, probeUniqueId) {
  if (expectedType === 'boolean')           return true;
  if (expectedType === 'integer')           return 1;
  if (expectedType === 'number')            return 1;
  if (expectedType === 'array')             return [];
  if (expectedType === 'object')            return {};
  // Default: string. Pick a semantically reasonable value from the field name.
  const lower = fieldName.toLowerCase();
  if (lower === 'uniqueid' || lower === 'externalid') return probeUniqueId;
  if (lower.endsWith('id'))                            return probeUniqueId + '-' + fieldName;
  if (lower.includes('email'))                         return 'probe-placeholder@example.com';
  if (lower.includes('url'))                           return 'https://probe.example.com/' + fieldName;
  if (lower.includes('timestamp') || lower.includes('date') || lower.endsWith('at') || lower.endsWith('seen')) {
    return new Date().toISOString();
  }
  if (lower.includes('version'))                       return '1.0.0';
  return `PROBE-${fieldName}`;
}

// ─── Per-platform probe routine ──────────────────────────────────────────────

const MAXIMALIST_FIELDS = {
  // Identity — uniqueId is the canonical Vanta name (2026-05-13 probe finding:
  // maximalist with externalId only → "must have property 'uniqueId'"). externalId
  // is included alongside so Phase B's rejected-field scan reveals whether Vanta
  // accepts it as an alias or rejects it as an extra key.
  uniqueId:              'placeholder',  // overridden per call with probeUniqueId
  externalId:            'placeholder',  // overridden per call; also tests for rejection
  displayName:           'Probe Device',
  // Owner linkage — Phase C tests these as the only variable
  ownerEmail:            'probe-owner@example.com',
  externalOwnerEmployeeId: 'emp-001',
  // OS info
  osType:                'MACOS',
  osVersion:             '14.2.1',
  operatingSystem:       'macOS',
  osFamily:              'Darwin',
  // Compliance signals (commonly modeled on Vanta computer resources)
  isEncrypted:           true,
  diskEncrypted:         true,
  isScreenLockEnabled:   true,
  screenLockEnabled:     true,
  hasAntivirusInstalled: true,
  antivirusInstalled:    true,
  hasPasswordManagerInstalled: true,
  passwordManagerInstalled: true,
  isManaged:             true,
  // Misc identifying
  serialNumber:          'PROBE-SERIAL-001',
  // Activity
  lastActiveSeen:        new Date().toISOString(),
  lastSeen:              new Date().toISOString(),
  lastCheckIn:           new Date().toISOString()
};

/**
 * Iteratively satisfy required-field validation. Vanta's schema validator
 * reports ONE missing-required field per 400 (2026-05-13 finding). On each
 * iteration, parse the next-required-field name out of the body, add it to
 * the payload with a typed placeholder, and re-PUT. Recovers from type
 * errors by replacing the placeholder with the expected type. Stops when:
 *   - status ≠ 400 (all required fields supplied — success), or
 *   - 400 with no parseable missing-property pattern (different error idiom), or
 *   - the same field is requested twice in a row (loop-guard), or
 *   - the iteration cap is reached
 */
async function discoverRequiredFields({ apiPath, resourceId, probeUniqueId, maxIterations = 25 }) {
  const payload = {};
  const discovered = [];

  for (let i = 1; i <= maxIterations; i++) {
    const result = await probe(
      `A.${i} · Iterative required-field discovery — [${discovered.join(', ') || '(empty payload)'}]`,
      async () => buildClient.put(apiPath, {
        resourceId,
        resources: [{ ...payload }]
      })
    );

    if (result.ok) {
      console.log(`  ✓ Phase A complete after ${i} iterations. Required fields: [${discovered.join(', ')}]`);
      return { discovered, finalPayload: payload, terminated: 'success', iterations: i };
    }

    // Type-error recovery first — Vanta told us a placeholder is the wrong
    // type for a field we already supplied; swap and retry the same iteration.
    const typeErrors = parseTypeErrors(result.body);
    if (typeErrors.length > 0) {
      const te = typeErrors[0];
      console.log(`  ↻ Type error on "${te.field}" — expected '${te.expectedType}'. Replacing placeholder.`);
      payload[te.field] = typedPlaceholder(te.field, te.expectedType, probeUniqueId);
      continue;
    }

    const missing = parseMissingFields(result.body);
    if (missing.length === 0) {
      console.log(`  ⚠ 400 with no parseable "must have property X" — discovery stops.`);
      return { discovered, finalPayload: payload, terminated: 'unparseable-400', iterations: i, lastResult: result };
    }

    const nextField = missing[0];
    if (discovered.includes(nextField)) {
      console.log(`  ⚠ Field "${nextField}" requested again after we supplied it — loop-guard fires.`);
      return { discovered, finalPayload: payload, terminated: 'loop-guard', iterations: i, lastField: nextField };
    }

    discovered.push(nextField);
    payload[nextField] = typedPlaceholder(nextField, null, probeUniqueId);
  }

  console.log(`  ⚠ Iteration cap (${maxIterations}) hit — required-field set may be incomplete.`);
  return { discovered, finalPayload: payload, terminated: 'iteration-cap', iterations: maxIterations };
}

async function probePlatform(label, resourceType, resourceId, stamp) {
  console.log('');
  console.log('████████████████████████████████████████████████████████████');
  console.log(`█ Platform: ${label}`);
  console.log(`█ Resource type (path segment): ${resourceType}`);
  console.log(`█ Resource ID: ${resourceId}`);
  console.log('████████████████████████████████████████████████████████████');

  const apiPath = `/v1/resources/${resourceType}`;
  const probeUniqueId = `LLAMALYNC-PROBE-${stamp}-${label.toUpperCase()}-001`;

  // ── Phase A · Iterative required-field discovery ────────────────────────
  const discovery = await discoverRequiredFields({
    apiPath, resourceId, probeUniqueId, maxIterations: 25
  });

  // Once required fields are satisfied, the discovered payload is our base
  // for the next two phases. Override uniqueId with the probe-stamp value
  // so different probe runs don't collide if the user re-runs.
  const requiredPayload = { ...discovery.finalPayload };
  if ('uniqueId' in requiredPayload) requiredPayload.uniqueId = probeUniqueId;

  // ── Phase B · Maximalist (required + every plausible extra) → rejected fields ──
  // Only meaningful if Phase A succeeded — otherwise we can't get past the
  // missing-required gate to see extra-key errors.
  let pMax = null;
  let rejected = [];
  if (discovery.terminated === 'success') {
    const maximalistPayload = {
      ...MAXIMALIST_FIELDS,
      ...requiredPayload,
      // Re-pin identity fields after spread (MAXIMALIST has placeholder strings)
      uniqueId: probeUniqueId,
      externalId: probeUniqueId
    };
    pMax = await probe(
      `B · Maximalist — required + every plausible extra; expect rejection list in body`,
      async () => buildClient.put(apiPath, {
        resourceId,
        resources: [maximalistPayload]
      })
    );
    rejected = parseExtraFields(pMax.body);
    console.log('  parsed rejected-field list:', JSON.stringify(rejected));
  } else {
    console.log(`[skip] Phase B (maximalist) — Phase A did not succeed (${discovery.terminated}).`);
  }

  // ── Phase C · Owner-linkage — required fields + one ownership key as the only variable ──
  let pOwnerEmail = null;
  let pExternalOwner = null;
  if (discovery.terminated === 'success') {
    pOwnerEmail = await probe(
      `C1 · Owner shape — required fields + ownerEmail (other ownership keys absent)`,
      async () => buildClient.put(apiPath, {
        resourceId,
        resources: [{ ...requiredPayload, ownerEmail: 'probe-owner@example.com' }]
      })
    );
    pExternalOwner = await probe(
      `C2 · Owner shape — required fields + externalOwnerEmployeeId (other ownership keys absent)`,
      async () => buildClient.put(apiPath, {
        resourceId,
        resources: [{ ...requiredPayload, externalOwnerEmployeeId: 'emp-001' }]
      })
    );
  } else {
    console.log(`[skip] Phase C (ownership) — Phase A did not succeed.`);
  }

  // ── Phase Z · Cleanup ───────────────────────────────────────────────────
  const cleanup = await probe(
    `Z · PUT empty resources — cleanup, exercises full-snapshot soft-delete`,
    async () => buildClient.put(apiPath, { resourceId, resources: [] })
  );

  return {
    label,
    resourceType,
    resourceId,
    apiPath,
    discovery,
    maximalist:    pMax ? { ok: pMax.ok, status: pMax.status, rejected } : null,
    ownerEmail:    pOwnerEmail ? { ok: pOwnerEmail.ok, status: pOwnerEmail.status, body: pOwnerEmail.body } : null,
    externalOwner: pExternalOwner ? { ok: pExternalOwner.ok, status: pExternalOwner.status, body: pExternalOwner.body } : null,
    cleanup: { ok: cleanup.ok, status: cleanup.status }
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const stamp = timestampSuffix();
  console.log('Probe run · timestamp:', stamp);
  console.log('App:        Build Integrations (20 req/min bucket)');
  console.log('Auth scope: connectors.self:read-resource connectors.self:write-resource');
  console.log('');

  const platforms = [
    {
      label: 'macos',
      resourceId:   process.env.VANTA_PROBE_MACOS_RESOURCE_ID,
      resourceType: process.env.VANTA_PROBE_MACOS_RESOURCE_TYPE
    },
    {
      label: 'windows',
      resourceId:   process.env.VANTA_PROBE_WINDOWS_RESOURCE_ID,
      resourceType: process.env.VANTA_PROBE_WINDOWS_RESOURCE_TYPE
    },
    {
      label: 'linux',
      resourceId:   process.env.VANTA_PROBE_LINUX_RESOURCE_ID,
      resourceType: process.env.VANTA_PROBE_LINUX_RESOURCE_TYPE
    }
  ];

  const results = [];
  const skipped = [];

  for (const p of platforms) {
    if (!p.resourceId || !p.resourceType) {
      skipped.push(p.label);
      console.log(`[skip] Platform ${p.label} — env vars not both set (RESOURCE_ID + RESOURCE_TYPE)`);
      continue;
    }
    const r = await probePlatform(p.label, p.resourceType, p.resourceId, stamp);
    results.push(r);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');

  if (skipped.length > 0) {
    console.log('');
    console.log('Platforms not probed (env vars unset):');
    for (const s of skipped) console.log('  -', s);
    if (skipped.includes('linux')) {
      console.log('');
      console.log('  ▶ Q5 (Linux Go/No-Go):');
      console.log('    LINUX env vars unset. Confirm in Dev Console → Resources tab:');
      console.log('    did the Base Resource Type dropdown show a Linux option at all?');
      console.log('      • If NO Linux option exists → Linux is natively unsupported.');
      console.log('        Implementation path: option (c) per amendment — surface Linux');
      console.log('        devices as "unsupported source row" in the dashboard for the');
      console.log('        SA demo moment. Document the decision in build-log.md.');
      console.log('      • If a Linux option existed but you skipped probing → rerun with');
      console.log('        VANTA_PROBE_LINUX_RESOURCE_ID + _RESOURCE_TYPE set.');
    }
  }

  for (const r of results) {
    console.log('');
    console.log(`── Platform: ${r.label} (${r.resourceType}) ──`);
    console.log('  API path:', r.apiPath);
    console.log('  Phase A required-field discovery:');
    console.log('    iterations:    ' + r.discovery.iterations);
    console.log('    terminated:    ' + r.discovery.terminated);
    console.log('    fields found:  ' + JSON.stringify(r.discovery.discovered));
    if (r.discovery.terminated !== 'success') {
      console.log('    ⚠ Discovery did not reach a 200 — required-field set is INCOMPLETE.');
      if (r.discovery.terminated === 'loop-guard') {
        console.log('    Field that stalled the loop: ' + r.discovery.lastField);
        console.log('    (Likely a regex/format constraint on the placeholder value.)');
      } else if (r.discovery.terminated === 'unparseable-400') {
        console.log('    The last 400 used a different error idiom — inspect the body above.');
      } else if (r.discovery.terminated === 'iteration-cap') {
        console.log('    Bump maxIterations in discoverRequiredFields if the field set is genuinely longer.');
      }
    }
    if (r.maximalist) {
      console.log('  Phase B (maximalist):     ' + statusLabel(r.maximalist) +
                  (r.maximalist.ok
                    ? ' (every probed field accepted — no extras rejected)'
                    : '  rejected=' + JSON.stringify(r.maximalist.rejected)));
    } else {
      console.log('  Phase B (maximalist):     skipped (Phase A did not succeed)');
    }
    if (r.ownerEmail && r.externalOwner) {
      console.log('  Phase C1 ownerEmail:              ' + statusLabel(r.ownerEmail) +
                  (r.ownerEmail.ok ? ' (accepted — likely canonical owner field)' : ' (rejected — see body)'));
      console.log('  Phase C2 externalOwnerEmployeeId: ' + statusLabel(r.externalOwner) +
                  (r.externalOwner.ok ? ' (accepted)' : ' (rejected — see body)'));
    } else {
      console.log('  Phase C (ownership):      skipped (Phase A did not succeed)');
    }
    console.log('  Cleanup (PUT []):         ' + statusLabel(r.cleanup) +
                (r.cleanup.ok ? ' — probe records soft-deleted' : ' — manual cleanup may be needed'));
  }

  console.log('');
  console.log('───────────────────────────────────────────────────────────');
  console.log('Next: paste the per-platform output above into a new section');
  console.log('in docs/build-log.md so the schema findings are committed before');
  console.log('Phase 1 implementation starts.');
  console.log('───────────────────────────────────────────────────────────');
}

main().catch(err => {
  console.error('Probe script crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
