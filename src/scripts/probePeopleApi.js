/**
 * Surgical probe of Vanta's Manage Vanta `/v1/people` write surface.
 *
 * Background: prior empirical work captured in docs/build-log.md and in code
 * comments at src/auth/authManager.js and src/sync/jobs/personnelSync.js
 * concluded that Vanta exposed NO write endpoint for the People entity.
 * Reviewer amendment to the GAP 2 plan states that current Vanta docs now
 * show `PATCH /v1/people/{personId}` for "Update person metadata" with a
 * NESTED body shape (groups like `name` and `employment`). This probe
 * verifies empirically.
 *
 * Open questions (from the approved GAP 2 plan, post-amendment + review):
 *
 *   Q1  Does `PATCH /v1/people/{personId}` exist? (build-log.md claims 404
 *       from earlier empirical work — confirm or refute.)
 *   Q2  What are the top-level body groups? (`name`, `employment`, others)
 *   Q3  Per HR enrichment, which fields are writable INDIVIDUALLY?
 *         - employment.jobTitle
 *         - employment.department
 *         - employment.employmentStatus
 *         - employment.employmentType
 *         - manager → tried in three candidate shapes (top-level
 *           `managerEmail`, nested `manager: { email }`,
 *           `employment: { managerEmail }`)
 *         - name.{givenName, familyName} (or name.first/name.last as fallback)
 *   Q4  Does PATCH accept a partial update inside a group (only send changed
 *       fields), or does it require full replacement of the group? Tested
 *       in the WINNING shape (nested OR flat).
 *   Q5  What error shape comes back for an unknown personId?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Setup before running this probe
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. Choose ONE person record in your Vanta sandbox tenant that is safe to
 *    mutate (a synthetic test user is ideal; do NOT use a real employee's
 *    record). The probe captures originals, runs many one-field PATCHes,
 *    and restores everything at the end — but a network failure mid-run
 *    could leave the record in an intermediate state.
 * 2. Set:    VANTA_PROBE_PERSON_ID=<id from GET /v1/people>
 * 3. No new Vanta Developer Console setup is required — reuses
 *    `vanta-api.all:read vanta-api.all:write`.
 *
 * ⚠ Token revocation note. The probe uses the singleton manageClient, which
 * caches a token on the existing `manageAuth` scope set. No standalone
 * OAuth call is made by this probe; in-process tokens are NOT revoked. Safe
 * to run while the dashboard server is up.
 *
 * Run: `node src/scripts/probePeopleApi.js`
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { manageClient } = require('../http/vantaClient');

const PEOPLE_PATH = '/v1/people';

// ─── Helpers ────────────────────────────────────────────────────────────────

function timestampSuffix() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hm = now.toTimeString().slice(0, 5).replace(':', '');
  return `${ymd}-${hm}`;
}

function shortJson(value, max = 1800) {
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

function pickPersonFromResponse(resp) {
  if (!resp) return null;
  return resp.data || resp.results?.data || resp;
}

function describeTopLevelKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).map(k => {
    const v = obj[k];
    const t = v === null ? 'null'
      : Array.isArray(v) ? `array(${v.length})`
      : typeof v === 'object' ? `object{${Object.keys(v).join(',')}}`
      : typeof v;
    return `${k}: ${t}`;
  });
}

function statusLabel(r) {
  return r?.ok ? 'OK' : `status=${r?.status}`;
}

/**
 * Pull a possibly-nested value from a person object, trying nested-group
 * read first then flat fallback. Used during snapshot so restore works
 * regardless of which shape Vanta uses on the response.
 */
function readField(person, group, field) {
  if (!person) return undefined;
  if (person[group] && typeof person[group] === 'object' && field in person[group]) {
    return person[group][field];
  }
  if (field in person) return person[field];
  return undefined;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const personId = process.env.VANTA_PROBE_PERSON_ID;
  if (!personId) {
    console.error('VANTA_PROBE_PERSON_ID must be set in .env before running this probe.');
    console.error('Pick a synthetic test person from your Vanta sandbox tenant; the probe');
    console.error('will GET, PATCH with synthetic values, then restore the originals.');
    process.exit(1);
  }

  const stamp = timestampSuffix();
  const probeVal = (suffix) => `LLAMALYNC-PROBE-${stamp}-${suffix}`;
  const url = `${PEOPLE_PATH}/${encodeURIComponent(personId)}`;

  console.log('Probe run · timestamp:', stamp);
  console.log('Endpoint:    ' + PEOPLE_PATH);
  console.log('Target id:   ' + personId);
  console.log('Bucket:      Manage Vanta (50 req/min)');
  console.log('Auth scope:  vanta-api.all:read vanta-api.all:write');

  // ── Probe 1 — GET list, capture top-level shape (groups visible there?) ──
  const pList = await probe(
    '1 · GET /v1/people?pageSize=1 — read shape and confirm endpoint',
    async () => manageClient.get(`${PEOPLE_PATH}?pageSize=1`)
  );
  const firstPerson = pickPersonFromResponse(pList.result)?.results?.data?.[0]
    ?? pickPersonFromResponse(pList.result)?.[0]
    ?? null;
  if (firstPerson) {
    console.log('  top-level keys on a person object:');
    for (const k of describeTopLevelKeys(firstPerson)) console.log('   ', k);
  }

  // ── Probe 2 — GET the specific target person, snapshot originals ─────────
  const pGet = await probe(
    `2 · GET ${url} — snapshot original values`,
    async () => manageClient.get(url)
  );
  if (!pGet.ok) {
    console.error('');
    console.error('Cannot proceed — could not read the target person.');
    console.error('Confirm VANTA_PROBE_PERSON_ID matches a real id from GET /v1/people.');
    process.exit(1);
  }
  const original = pickPersonFromResponse(pGet.result);

  // Snapshot every field we might mutate. readField() handles either shape.
  const snapshot = {
    jobTitle:         readField(original, 'employment', 'jobTitle'),
    department:       readField(original, 'employment', 'department'),
    employmentStatus: readField(original, 'employment', 'employmentStatus'),
    employmentType:   readField(original, 'employment', 'employmentType'),
    managerEmail_topLevel:        original?.managerEmail,
    managerEmail_underEmployment: original?.employment?.managerEmail,
    managerEmail_underManager:    original?.manager?.email,
    name_givenName:  readField(original, 'name', 'givenName'),
    name_familyName: readField(original, 'name', 'familyName'),
    name_first:      readField(original, 'name', 'first'),
    name_last:       readField(original, 'name', 'last'),
    // 2026-05-13 first-pass finding: PATCH endpoint exists but employment/name
    // HR fields are all rejected as excess properties. These three additional
    // top-level fields surfaced in the GET response shape — probe whether any
    // of them accept writes, to fully scope the writable surface.
    emailAddress:    original?.emailAddress,
    groupIds:        Array.isArray(original?.groupIds) ? [...original.groupIds] : original?.groupIds,
    leaveInfo:       original?.leaveInfo
  };

  console.log('');
  console.log('Snapshotted originals:');
  for (const [k, v] of Object.entries(snapshot)) {
    console.log(`  ${k.padEnd(32, ' ')} → ${JSON.stringify(v)}`);
  }

  // ── Probe 3 — Shape detection: nested vs flat for jobTitle ──────────────
  // jobTitle is the baseline field because every probe target almost
  // certainly has one. Establishes which body shape Vanta accepts.
  const pNestedJobTitle = await probe(
    `3a · NESTED · PATCH { employment: { jobTitle: '${probeVal('JOBTITLE')}' } }`,
    async () => manageClient.patch(url, { employment: { jobTitle: probeVal('JOBTITLE') } })
  );

  let pFlatJobTitle = null;
  if (!pNestedJobTitle.ok) {
    pFlatJobTitle = await probe(
      `3b · FLAT · PATCH { jobTitle: '${probeVal('JOBTITLE')}' } (fallback because nested failed)`,
      async () => manageClient.patch(url, { jobTitle: probeVal('JOBTITLE') })
    );
  }

  const winningShape = pNestedJobTitle.ok ? 'nested' : (pFlatJobTitle?.ok ? 'flat' : 'none');
  console.log('');
  console.log('▶ Winning shape:', winningShape);
  if (winningShape === 'none') {
    console.log('  Neither nested nor flat PATCH accepted. Subsequent one-at-a-time probes');
    console.log('  will run with the NESTED shape for diagnostic value, but no restore is');
    console.log('  required (no writes succeeded).');
  }

  // Helper that wraps a single-field write in the winning shape (defaulting
  // to nested for diagnostic value when neither shape works).
  function shaped(group, field, value) {
    if (winningShape === 'flat') return { [field]: value };
    return { [group]: { [field]: value } };
  }

  // ── Probe 4 — One-at-a-time field probes ────────────────────────────────
  // For STRING fields (jobTitle, department): write a distinct probe value.
  // For ENUM-likely fields (employmentStatus, employmentType): write the
  // current snapshotted value when present — confirms Vanta accepts the
  // shape without exercising an unknown enum. If the snapshot value is
  // null/undefined, fall back to a generic candidate ("ACTIVE", "FULL_TIME").
  // For name: probe both nested-group keys (givenName/familyName) and the
  // alternate-key fallback (first/last) since the field naming isn't yet
  // confirmed.
  // For manager: probe THREE candidate shapes since the docs don't pin
  // down which Vanta uses.

  const p4 = {};

  p4.jobTitle_baseline = pNestedJobTitle.ok ? pNestedJobTitle : pFlatJobTitle;

  p4.department = await probe(
    `4b · PATCH employment.department = '${probeVal('DEPT')}'`,
    async () => manageClient.patch(url, shaped('employment', 'department', probeVal('DEPT')))
  );

  // employmentStatus: write current value if known, else try "ACTIVE".
  const empStatusProbeVal = snapshot.employmentStatus ?? 'ACTIVE';
  p4.employmentStatus = await probe(
    `4c · PATCH employment.employmentStatus = ${JSON.stringify(empStatusProbeVal)}` +
      (snapshot.employmentStatus == null ? ' (snapshot was null — using "ACTIVE" candidate)' : ' (snapshot value, shape-only test)'),
    async () => manageClient.patch(url, shaped('employment', 'employmentStatus', empStatusProbeVal))
  );

  // employmentType: same pattern, candidate "FULL_TIME".
  const empTypeProbeVal = snapshot.employmentType ?? 'FULL_TIME';
  p4.employmentType = await probe(
    `4d · PATCH employment.employmentType = ${JSON.stringify(empTypeProbeVal)}` +
      (snapshot.employmentType == null ? ' (snapshot was null — using "FULL_TIME" candidate)' : ' (snapshot value, shape-only test)'),
    async () => manageClient.patch(url, shaped('employment', 'employmentType', empTypeProbeVal))
  );

  // name — try the two most common Vanta naming conventions.
  p4.name_givenName = await probe(
    `4e-i · PATCH name.givenName = '${probeVal('NAME-GIVEN')}'`,
    async () => manageClient.patch(url, shaped('name', 'givenName', probeVal('NAME-GIVEN')))
  );
  p4.name_familyName = await probe(
    `4e-ii · PATCH name.familyName = '${probeVal('NAME-FAMILY')}'`,
    async () => manageClient.patch(url, shaped('name', 'familyName', probeVal('NAME-FAMILY')))
  );
  // Only run the first/last fallback if the canonical givenName/familyName both 400'd
  if (!p4.name_givenName.ok && !p4.name_familyName.ok) {
    p4.name_first = await probe(
      `4e-iii · PATCH name.first = '${probeVal('NAME-FIRST')}' (fallback because givenName rejected)`,
      async () => manageClient.patch(url, shaped('name', 'first', probeVal('NAME-FIRST')))
    );
    p4.name_last = await probe(
      `4e-iv · PATCH name.last = '${probeVal('NAME-LAST')}' (fallback because familyName rejected)`,
      async () => manageClient.patch(url, shaped('name', 'last', probeVal('NAME-LAST')))
    );
  }

  // Manager — three candidate shapes. Use a current-known email if any,
  // otherwise a synthetic example (Vanta will likely 422 with "Resource
  // not found" but the shape gets exercised).
  const managerCandidateEmail =
    snapshot.managerEmail_topLevel
    || snapshot.managerEmail_underEmployment
    || snapshot.managerEmail_underManager
    || 'probe-manager@example.com';

  p4.manager_topLevel = await probe(
    `4f-i · PATCH { managerEmail: ${JSON.stringify(managerCandidateEmail)} } (top-level flat)`,
    async () => manageClient.patch(url, { managerEmail: managerCandidateEmail })
  );
  p4.manager_underEmployment = await probe(
    `4f-ii · PATCH { employment: { managerEmail: ${JSON.stringify(managerCandidateEmail)} } } (under employment)`,
    async () => manageClient.patch(url, { employment: { managerEmail: managerCandidateEmail } })
  );
  p4.manager_underManagerGroup = await probe(
    `4f-iii · PATCH { manager: { email: ${JSON.stringify(managerCandidateEmail)} } } (separate manager group)`,
    async () => manageClient.patch(url, { manager: { email: managerCandidateEmail } })
  );

  // ── 4g/4h/4i — top-level fields visible on the GET response shape ───────
  // Added after the first-pass probe revealed all employment/name HR fields
  // are rejected as "excess property". These three are top-level keys present
  // on the People entity (per the GET response): emailAddress, groupIds,
  // leaveInfo. Probe whether the PATCH endpoint accepts writes to any of them.
  //
  // emailAddress: try changing to a distinct probe value; restore on success.
  // groupIds:     send the snapshot value back (shape-only test; no actual change).
  // leaveInfo:    send {} if currently null, otherwise send snapshot value.
  //               {} probes both shape ("X is required" errors reveal sub-fields)
  //               and write-ability ("excess property" means it's not writable at all).

  const probeEmailAddress = `probe-email-${stamp}@example.com`;
  p4.emailAddress = await probe(
    `4g · PATCH { emailAddress: ${JSON.stringify(probeEmailAddress)} } — top-level string write test`,
    async () => manageClient.patch(url, { emailAddress: probeEmailAddress })
  );

  const groupIdsForProbe = Array.isArray(snapshot.groupIds) ? snapshot.groupIds : [];
  p4.groupIds = await probe(
    `4h · PATCH { groupIds: ${JSON.stringify(groupIdsForProbe)} } — shape-only (snapshot value re-sent)`,
    async () => manageClient.patch(url, { groupIds: groupIdsForProbe })
  );

  const leaveInfoProbeValue = snapshot.leaveInfo === null || snapshot.leaveInfo === undefined
    ? {}
    : snapshot.leaveInfo;
  p4.leaveInfo = await probe(
    `4i · PATCH { leaveInfo: ${JSON.stringify(leaveInfoProbeValue)} } — ` +
      (snapshot.leaveInfo == null
        ? 'empty object probe (current is null/absent)'
        : 'snapshot value re-sent'),
    async () => manageClient.patch(url, { leaveInfo: leaveInfoProbeValue })
  );

  // ── Probe 5 — Partial-update semantics ─────────────────────────────────
  // Tests: send only ONE field of a group whose other fields we just wrote
  // probe values into. Read back. If the omitted fields preserve their
  // probe values, PATCH is idiomatic partial-update. If they revert to
  // null/empty, Vanta treats the PATCH as full-group replacement.
  let p5PartialPatch = null;
  let p5ReadAfter = null;
  if (winningShape !== 'none') {
    p5PartialPatch = await probe(
      `5 · PARTIAL test — PATCH only ${winningShape === 'nested' ? 'employment.jobTitle' : 'jobTitle'} ` +
      `(different value, expect employment.department to PRESERVE the probe value from 4b)`,
      async () => manageClient.patch(url, shaped('employment', 'jobTitle', probeVal('JOBTITLE-A')))
    );
    p5ReadAfter = await probe(
      `5b · GET ${url} — read back; check whether employment.department preserved`,
      async () => manageClient.get(url)
    );
  } else {
    console.log('');
    console.log('Skipping Probe 5 (partial-update) — no PATCH shape succeeded.');
  }

  // ── Probe 6 — Unknown personId error shape ──────────────────────────────
  const bogusId = 'llamalync-probe-nonexistent-' + Date.now();
  const pBogus = await probe(
    `6 · PATCH ${PEOPLE_PATH}/${bogusId} (deliberately invalid id) — capture error shape`,
    async () => manageClient.patch(
      `${PEOPLE_PATH}/${encodeURIComponent(bogusId)}`,
      shaped('employment', 'jobTitle', 'PROBE')
    )
  );

  // ── Restore originals ───────────────────────────────────────────────────
  console.log('');
  console.log('═══ Restoring original values ═══');
  if (winningShape === 'none') {
    console.log('No PATCH variant succeeded — record state unchanged, no restore needed.');
  } else {
    // Build a comprehensive restore payload in the winning shape. If a field
    // was originally absent but this probe successfully wrote it, send null to
    // clear the synthetic probe value rather than omitting it and leaving it
    // behind on the sandbox record.
    const restoreBody = {};
    const restoreValue = (original, touched) => {
      if (original !== undefined) return original;
      return touched ? null : undefined;
    };
    const setIfNeeded = (obj, key, value) => {
      if (value !== undefined) obj[key] = value;
    };

    const employmentFields = {};
    setIfNeeded(employmentFields, 'jobTitle',
      restoreValue(snapshot.jobTitle, p4.jobTitle_baseline?.ok || p5PartialPatch?.ok));
    setIfNeeded(employmentFields, 'department',
      restoreValue(snapshot.department, p4.department?.ok));
    setIfNeeded(employmentFields, 'employmentStatus',
      restoreValue(snapshot.employmentStatus, p4.employmentStatus?.ok));
    setIfNeeded(employmentFields, 'employmentType',
      restoreValue(snapshot.employmentType, p4.employmentType?.ok));

    const employmentManagerEmail = restoreValue(
      snapshot.managerEmail_underEmployment,
      p4.manager_underEmployment?.ok
    );

    const nameFields = {};
    setIfNeeded(nameFields, 'givenName',
      restoreValue(snapshot.name_givenName, p4.name_givenName?.ok));
    setIfNeeded(nameFields, 'familyName',
      restoreValue(snapshot.name_familyName, p4.name_familyName?.ok));
    setIfNeeded(nameFields, 'first',
      restoreValue(snapshot.name_first, p4.name_first?.ok));
    setIfNeeded(nameFields, 'last',
      restoreValue(snapshot.name_last, p4.name_last?.ok));

    const managerGroup = {};
    setIfNeeded(managerGroup, 'email',
      restoreValue(snapshot.managerEmail_underManager, p4.manager_underManagerGroup?.ok));

    const topLevelManagerEmail = restoreValue(
      snapshot.managerEmail_topLevel,
      p4.manager_topLevel?.ok
    );

    if (winningShape === 'nested') {
      if (employmentManagerEmail !== undefined) employmentFields.managerEmail = employmentManagerEmail;
      if (Object.keys(employmentFields).length) restoreBody.employment = employmentFields;
      if (Object.keys(nameFields).length)       restoreBody.name = nameFields;
    } else {
      // flat
      Object.assign(restoreBody, employmentFields, nameFields);
      if (employmentManagerEmail !== undefined) {
        restoreBody.employment = { managerEmail: employmentManagerEmail };
      }
    }
    if (Object.keys(managerGroup).length) restoreBody.manager = managerGroup;
    if (topLevelManagerEmail !== undefined) restoreBody.managerEmail = topLevelManagerEmail;

    // Top-level fields probed in 4g/4h/4i: restore originals if the probe
    // touched them. groupIds was sent as the snapshot value so it never
    // requires a restore even on success; included here defensively in case
    // future probe variants change that.
    if (p4.emailAddress?.ok && snapshot.emailAddress !== undefined) {
      restoreBody.emailAddress = snapshot.emailAddress;
    }
    if (p4.groupIds?.ok && snapshot.groupIds !== undefined) {
      restoreBody.groupIds = snapshot.groupIds;
    }
    if (p4.leaveInfo?.ok && snapshot.leaveInfo !== leaveInfoProbeValue) {
      // If we wrote {} but original was null, restore to null. If original
      // was an object and we re-sent it, no restore needed.
      restoreBody.leaveInfo = snapshot.leaveInfo === undefined ? null : snapshot.leaveInfo;
    }

    await probe(
      'Restore · PATCH original values (full snapshot, winning shape)',
      async () => manageClient.patch(url, restoreBody)
    );
  }

  // Final read for visual confirmation.
  const pFinal = await probe(
    `Restore-check · GET ${url} — read back final state`,
    async () => manageClient.get(url)
  );

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');

  console.log('');
  console.log('Q1 — Does PATCH /v1/people/{personId} exist?');
  if (winningShape === 'nested') {
    console.log('  YES — endpoint accepts PATCH with NESTED body { employment: { ... } } (matches amendment).');
    console.log('  Earlier build-log.md note ("Person write API not supported") is STALE — revise the integration notes.');
  } else if (winningShape === 'flat') {
    console.log('  YES — endpoint accepts PATCH with FLAT body { jobTitle: ... } (CONTRADICTS amendment).');
    console.log('  Implementation should use flat shape; update the integration notes accordingly.');
  } else {
    console.log('  NO — neither nested nor flat PATCH succeeded.');
    console.log(`  Nested status=${pNestedJobTitle.status}; flat status=${pFlatJobTitle?.status}.`);
    console.log('  GAP 2 falls back to customFields-on-user_account workaround per the plan amendment.');
  }

  console.log('');
  console.log('Q2 — Top-level body groups observed');
  if (firstPerson) {
    for (const k of describeTopLevelKeys(firstPerson)) console.log('   ', k);
  }

  console.log('');
  console.log('Q3 — Per-field PATCH outcomes (in winning shape):');
  console.log('  4a employment.jobTitle         ' + statusLabel(p4.jobTitle_baseline));
  console.log('  4b employment.department       ' + statusLabel(p4.department));
  console.log('  4c employment.employmentStatus ' + statusLabel(p4.employmentStatus));
  console.log('  4d employment.employmentType   ' + statusLabel(p4.employmentType));
  console.log('  4e-i  name.givenName           ' + statusLabel(p4.name_givenName));
  console.log('  4e-ii name.familyName          ' + statusLabel(p4.name_familyName));
  if (p4.name_first)  console.log('  4e-iii name.first             ' + statusLabel(p4.name_first));
  if (p4.name_last)   console.log('  4e-iv  name.last              ' + statusLabel(p4.name_last));
  console.log('  4f-i   { managerEmail }              ' + statusLabel(p4.manager_topLevel));
  console.log('  4f-ii  { employment: { managerEmail } } ' + statusLabel(p4.manager_underEmployment));
  console.log('  4f-iii { manager: { email } }        ' + statusLabel(p4.manager_underManagerGroup));
  const managerWinner =
    p4.manager_underManagerGroup.ok ? '{ manager: { email } }' :
    p4.manager_underEmployment.ok   ? '{ employment: { managerEmail } }' :
    p4.manager_topLevel.ok          ? '{ managerEmail }' :
    null;
  if (managerWinner) console.log('  → Manager shape:', managerWinner);
  else               console.log('  → Manager: no candidate shape succeeded. See Probe 4f bodies for the required key.');
  console.log('  4g  { emailAddress }                  ' + statusLabel(p4.emailAddress));
  console.log('  4h  { groupIds: [...] }               ' + statusLabel(p4.groupIds));
  console.log('  4i  { leaveInfo: {} }                 ' + statusLabel(p4.leaveInfo));
  const topLevelWritable = [
    p4.emailAddress?.ok && 'emailAddress',
    p4.groupIds?.ok      && 'groupIds',
    p4.leaveInfo?.ok     && 'leaveInfo'
  ].filter(Boolean);
  if (topLevelWritable.length) {
    console.log('  → Top-level writable surface includes:', topLevelWritable.join(', '));
  } else {
    console.log('  → No top-level field accepted writes — endpoint is read-mostly + name-only.');
  }

  console.log('');
  console.log('Q4 — Partial-update semantics');
  if (p5PartialPatch?.ok && p5ReadAfter?.ok) {
    const after = pickPersonFromResponse(p5ReadAfter.result);
    const deptAfter = readField(after, 'employment', 'department');
    const expectedDept = probeVal('DEPT');  // value written by 4b
    console.log(`  After partial PATCH (jobTitle only), employment.department reads back as: ${JSON.stringify(deptAfter)}`);
    console.log(`  Expected (if partial preserves):                                            ${JSON.stringify(expectedDept)}`);
    if (deptAfter === expectedDept) {
      console.log('  → PRESERVES omitted fields (idiomatic PATCH semantics).');
      console.log('  → Implementation can send only changed fields per group.');
    } else if (deptAfter == null) {
      console.log('  → CLEARED the omitted field — Vanta treats the PATCH as full-group replacement.');
      console.log('  → Implementation must send the full group on every PATCH.');
    } else {
      console.log('  → Unexpected — inspect Probe 5b response body for the actual after-state.');
    }
  } else {
    console.log('  Not exercised — no PATCH shape succeeded in Probe 3, so partial semantics N/A.');
  }

  console.log('');
  console.log('Q5 — Unknown personId error shape');
  console.log(`  status: ${pBogus.status}`);
  console.log('  body:   ', shortJson(pBogus.body, 500));

  console.log('');
  console.log('Restore status:');
  if (pFinal.ok) {
    const final = pickPersonFromResponse(pFinal.result);
    const checks = [
      { field: 'jobTitle',         finalVal: readField(final, 'employment', 'jobTitle'),         orig: snapshot.jobTitle },
      { field: 'department',       finalVal: readField(final, 'employment', 'department'),       orig: snapshot.department },
      { field: 'employmentStatus', finalVal: readField(final, 'employment', 'employmentStatus'), orig: snapshot.employmentStatus },
      { field: 'employmentType',   finalVal: readField(final, 'employment', 'employmentType'),   orig: snapshot.employmentType },
      { field: 'managerEmail(top)', finalVal: final?.managerEmail, orig: snapshot.managerEmail_topLevel },
      { field: 'managerEmail(emp)', finalVal: final?.employment?.managerEmail, orig: snapshot.managerEmail_underEmployment },
      { field: 'manager.email', finalVal: final?.manager?.email, orig: snapshot.managerEmail_underManager },
      { field: 'name.givenName', finalVal: readField(final, 'name', 'givenName'), orig: snapshot.name_givenName },
      { field: 'name.familyName', finalVal: readField(final, 'name', 'familyName'), orig: snapshot.name_familyName },
      { field: 'name.first', finalVal: readField(final, 'name', 'first'), orig: snapshot.name_first },
      { field: 'name.last', finalVal: readField(final, 'name', 'last'), orig: snapshot.name_last }
    ];
    let allMatch = true;
    for (const c of checks) {
      const match = c.finalVal === c.orig || (c.orig === undefined && c.finalVal == null);
      if (!match) allMatch = false;
      console.log(`  ${match ? '✓' : '⚠'} ${c.field.padEnd(20, ' ')} final=${JSON.stringify(c.finalVal)}  orig=${JSON.stringify(c.orig)}`);
    }
    if (allMatch) {
      console.log('  ✓ All snapshotted fields restored or cleared back to absent/null.');
    } else {
      console.log('  ⚠ One or more fields differ from originals — verify state in Vanta UI.');
    }
  } else {
    console.log('  Final GET failed — verify the record state manually in Vanta UI.');
  }

  console.log('');
  console.log('───────────────────────────────────────────────────────────');
  console.log('Next: paste the per-probe output above into a new section in');
  console.log('docs/build-log.md. Focus on:');
  console.log('  - Q1 (endpoint + winning shape)');
  console.log('  - Q3 (which individual fields PATCH accepted, especially manager shape)');
  console.log('  - Q4 (partial vs full-group replacement — drives enrichment payload design)');
  console.log('───────────────────────────────────────────────────────────');
}

main().catch(err => {
  console.error('Probe script crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
