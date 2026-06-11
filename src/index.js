require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const logger = require('./utils/logger');
const { startScheduler } = require('./scheduler/scheduler');
const { registerWebhookRoute } = require('./webhooks/webhookReceiver');
const dashboardRouter = require('./dashboard');
const { router: mockHrisRouter } = require('./mockHris');
const { router: mockRiskRouter } = require('./mockRiskRegister');
const { router: mockCmdbRouter } = require('./mockCmdb');
const { router: mockEvidenceRouter } = require('./mockEvidenceStore');
const { router: mockWorkflowSinkRouter } = require('./mockWorkflowSink');
const { renderLoginPage } = require('./dashboard/loginPage');
const { passwordsMatch } = require('./auth/passwordCheck');
const { runWithSyncLock, SyncBusyError } = require('./utils/syncLocks');

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most platform-as-a-service hosts) puts a proxy in front of us.
// Trusting the first proxy hop lets req.ip surface the real client IP from
// X-Forwarded-For instead of the proxy's own IP — required for the login
// throttle below to lock out individual attackers, not the whole proxy.
//
// IMPORTANT: this is only safe when LlamaLync is actually deployed behind a
// trusted proxy (Render, Fly, Railway, etc.). If you fork this and run it
// directly on the public internet without a proxy, an attacker can spoof
// X-Forwarded-For and rotate IPs through the throttle. Set to false in that
// case, or use req.socket.remoteAddress in the throttle directly.
app.set('trust proxy', 1);

// ─── Auth ────────────────────────────────────────────────────────────────────
// In production, both LLAMALYNC_PASSWORD and LLAMALYNC_SESSION_SECRET must be
// set — refuse to start otherwise so a missing env var on Render can't silently
// expose the dashboard or sign sessions with a default secret.
if (process.env.NODE_ENV === 'production') {
  if (!process.env.LLAMALYNC_PASSWORD) {
    throw new Error('LLAMALYNC_PASSWORD must be set in production — refusing to start');
  }
  if (!process.env.LLAMALYNC_SESSION_SECRET) {
    throw new Error('LLAMALYNC_SESSION_SECRET must be set in production — refusing to start');
  }
}

const SESSION_COOKIE = 'llamalync_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// In dev, default session secret is fine; in prod the startup check above
// guarantees the env var is set, so this fallback never fires there.
const SESSION_SECRET = process.env.LLAMALYNC_SESSION_SECRET || 'dev-only-session-secret';

function signToken() {
  const issuedAt = Date.now().toString();
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(issuedAt).digest('hex');
  return `${issuedAt}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const issuedAt = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(issuedAt).digest('hex');
  // timingSafeEqual throws on length mismatch, so guard with length first.
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const age = Date.now() - parseInt(issuedAt, 10);
  return age >= 0 && age < SESSION_TTL_MS;
}

function readSessionCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(SESSION_COOKIE + '=')) {
      try {
        return decodeURIComponent(trimmed.slice(SESSION_COOKIE.length + 1));
      } catch {
        // Malformed percent-encoding (e.g. "%E0%A4%A") — treat as no cookie
        // rather than throwing 500. Behaves like an unauthenticated request.
        return null;
      }
    }
  }
  return null;
}

function setSessionCookie(res) {
  res.cookie(SESSION_COOKIE, signToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
}

// Login brute-force throttle: simple in-memory IP-based counter. After
// LOGIN_MAX_ATTEMPTS failures within LOGIN_ATTEMPT_WINDOW_MS, the IP is
// locked out for LOGIN_LOCKOUT_MS. Successful login clears the counter.
// Resets on server restart (acceptable for a POC). Tracks based on req.ip,
// which trust-proxy resolves to the real client IP through Render's proxy.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
const loginAttempts = new Map();

function recordLoginFailure(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, firstAt: now, lockedUntil: 0 };
  if (now - record.firstAt > LOGIN_ATTEMPT_WINDOW_MS) {
    record.count = 0;
    record.firstAt = now;
  }
  record.count++;
  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    record.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
  loginAttempts.set(ip, record);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function isLockedOut(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (Date.now() < record.lockedUntil) return true;
  // Lockout expired — clear the record so the user starts fresh.
  if (record.lockedUntil > 0) loginAttempts.delete(ip);
  return false;
}

// Periodic sweep — evicts loginAttempts entries that are past their attempt
// window AND not currently locked out. Without this, IPs with 1-4 failed
// attempts that never come back accumulate forever (small leak, but real).
const LOGIN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    const expired = now - record.firstAt > LOGIN_ATTEMPT_WINDOW_MS;
    const notLocked = now >= record.lockedUntil;
    if (expired && notLocked) loginAttempts.delete(ip);
  }
}, LOGIN_SWEEP_INTERVAL_MS).unref(); // .unref so the timer doesn't keep the process alive

// Auth middleware: verify session cookie, redirect HTML clients to /login,
// return 401 JSON to API callers. /health and /webhooks/* stay open (Render
// healthcheck, Vanta webhook). /login and /assets/* are also open — login
// page needs to render before auth, and the page references /assets/logo.png.
// If LLAMALYNC_PASSWORD is unset (local dev only), auth is disabled entirely.
function sessionAuth(req, res, next) {
  if (req.path === '/health' || req.path.startsWith('/webhooks/')) return next();
  if (req.path === '/login' || req.path.startsWith('/assets/')) return next();

  const expectedPassword = process.env.LLAMALYNC_PASSWORD;
  if (!expectedPassword) return next();

  const token = readSessionCookie(req);
  if (verifyToken(token)) return next();

  const acceptsHtml = (req.headers.accept || '').includes('text/html');
  if (acceptsHtml) {
    return res.redirect('/login');
  }
  return res.status(401).json({ error: 'Authentication required' });
}

// CSRF protection: Basic Auth credentials are sent automatically on cross-origin
// requests, so a malicious page could trigger our state-changing POSTs. In
// production, require the Origin or Referer header's *parsed host* to exactly
// equal our request Host header. Skipped in dev so curl from terminal still
// works during local testing.
//
// IMPORTANT: substring matching (`origin.includes(host)`) is bypassable by an
// attacker who registers a domain like `victim.example.com.evil.test` — the
// victim's host appears as a substring of the attacker's origin. We use strict
// URL parsing + host equality to close that.
function csrfCheck(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.path.startsWith('/webhooks/')) return next(); // HMAC-verified path

  const originOrReferer = req.headers.origin || req.headers.referer || '';
  const host = req.headers.host || '';

  if (!originOrReferer || !host) {
    return res.status(403).json({ error: 'CSRF check failed: missing Origin/Referer' });
  }

  let parsedHost;
  try {
    parsedHost = new URL(originOrReferer).host;
  } catch {
    return res.status(403).json({ error: 'CSRF check failed: malformed Origin/Referer' });
  }

  if (parsedHost !== host) {
    return res.status(403).json({ error: 'CSRF check failed: Origin/Referer host does not match' });
  }
  next();
}

app.use(sessionAuth);
app.use(csrfCheck);

// Propagates Vanta's actual HTTP status + body through the LlamaLync API
// rather than coding every Vanta error as a generic 500. axios errors carry
// `response.status` (the upstream status) and `response.data` (the upstream
// body); we read both, prefer Vanta's own error message over axios's generic
// "Request failed with status code N" wrapper, and surface the raw body so
// the dashboard can show the operator exactly which field Vanta rejected.
function respondWithError(res, err) {
  const vantaStatus = err.response?.status;
  const vantaBody   = err.response?.data;
  const status      = vantaStatus || err.statusCode || 500;
  const message     = (vantaBody && (vantaBody.error || vantaBody.message))
    || err.message
    || 'Unknown error';
  // err.stats / err.partial are set by sync jobs that completed with
  // partial success (e.g. deviceSync: macOS pushed, Windows failed).
  // Surface them so the dashboard can render the partial outcome instead
  // of treating the whole operation as a failure.
  const body = { error: message, vantaStatus, vantaBody };
  if (err.partial !== undefined) body.partial = err.partial;
  if (err.stats   !== undefined) body.stats   = err.stats;
  res.status(status).json(body);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check — useful for Render/Railway uptime monitoring
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Static assets (logo, etc.) — served unauthenticated so the login page
// can render the brand mark before the user has logged in.
app.use('/assets', express.static(path.join(__dirname, '..', 'assets'), {
  maxAge: '1d',
  index: false
}));

// ─── Login / logout ──────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  // Already logged in → bounce to dashboard
  if (verifyToken(readSessionCookie(req))) return res.redirect('/');
  res.type('html').send(renderLoginPage());
});

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const expectedPassword = process.env.LLAMALYNC_PASSWORD;
  // If auth is disabled (no password set), still let users hit /login but
  // just send them to the dashboard.
  if (!expectedPassword) return res.redirect('/');

  const ip = req.ip || 'unknown';
  if (isLockedOut(ip)) {
    return res.status(429).type('html').send(renderLoginPage({
      error: 'Too many failed attempts. Try again in a few minutes.'
    }));
  }

  const submitted = (req.body && req.body.password) || '';
  // passwordsMatch handles the UTF-8 byte-length vs UTF-16 code-unit-length
  // discrepancy — a multi-byte char in the submitted password no longer
  // crashes timingSafeEqual with a 500. See src/auth/passwordCheck.js.
  const passMatch = passwordsMatch(submitted, expectedPassword);

  if (!passMatch) {
    recordLoginFailure(ip);
    logger.warn('Login failure', { ip });
    return res.status(401).type('html').send(renderLoginPage({ error: 'Incorrect password' }));
  }

  clearLoginAttempts(ip);
  setSessionCookie(res);
  // LLAMALYNC_USER carries the (single) user identity for audit logs. Not
  // checked at auth time — password is the only credential — but logged here
  // so deployment logs show "who" signed in alongside the source IP.
  logger.info('Login success', { user: process.env.LLAMALYNC_USER || 'sa_team', ip });
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/login');
});

// Webhook receiver — registered FIRST so its express.raw() body parser runs
// before any json parser later in the chain (the mock routers each apply
// their own express.json() globally, which would otherwise consume the body
// before we can verify the HMAC).
registerWebhookRoute(app);

// Fake "People-X" HRIS endpoints — stand in for the customer's bespoke HR system.
app.use('/', mockHrisRouter);

// Fake "Risk-X" register endpoints — stand in for the customer's homegrown
// risk register (the scenario the Risk tab demonstrates).
app.use('/', mockRiskRouter);

// Fake "CMDB-X" inventory endpoints — stand in for the customer's homegrown
// asset inventory (the scenario the Devices tab demonstrates).
app.use('/', mockCmdbRouter);

// Fake "Evidence-X" file store endpoints — stand in for the customer's
// local compliance-evidence repository (SharePoint folder, S3 bucket,
// GRC tool export). The scenario the Evidence tab demonstrates.
app.use('/', mockEvidenceRouter);

// Fake "Workflow Sink" downstream destination — stand in for the customer's
// compliance workflow system that webhooks forward to. Inverted flow vs.
// the source-mocks above: Workflow Sink RECEIVES data from LlamaLync's
// webhook forward pipeline rather than serving as a source.
app.use('/', mockWorkflowSinkRouter);

// Dashboard — `/` renders the HTML demo view, `/dashboard.json` returns
// the same data as JSON for programmatic use.
app.use('/', dashboardRouter);

// Standard JSON parsing for all other routes
app.use(express.json());

// Manual sync triggers — useful during development and for demos
// Each manual sync route shares a process-wide lock with the cron scheduler
// (src/utils/syncLocks.js) so the operator can't accidentally race a sync
// against an in-flight scheduled run targeting the same Vanta resource.
// On contention the route returns 409 immediately — no queueing — so the
// dashboard can render a clear "already running" toast and the operator
// can decide when to retry.
app.post('/sync/personnel', async (req, res) => {
  const { runPersonnelSync } = require('./sync/jobs/personnelSync');
  try {
    const stats = await runWithSyncLock('personnel', () => runPersonnelSync());
    res.json({ ok: true, stats });
  } catch (err) {
    if (err instanceof SyncBusyError) {
      return res.status(409).json({ error: 'Personnel sync already running', code: 'SYNC_BUSY' });
    }
    respondWithError(res, err);
  }
});

app.post('/sync/devices', async (req, res) => {
  const { runDeviceSync } = require('./sync/jobs/deviceSync');
  try {
    const stats = await runWithSyncLock('devices', () => runDeviceSync());
    res.json({ ok: true, stats });
  } catch (err) {
    if (err instanceof SyncBusyError) {
      return res.status(409).json({ error: 'Device sync already running', code: 'SYNC_BUSY' });
    }
    respondWithError(res, err);
  }
});

app.post('/sync/vulns', async (req, res) => {
  const { runVulnSync } = require('./sync/jobs/vulnSync');
  try {
    const stats = await runVulnSync();
    res.json({ ok: true, stats });
  } catch (err) {
    respondWithError(res, err);
  }
});

app.post('/sync/risk', async (req, res) => {
  const { runRiskSync } = require('./sync/jobs/riskSync');
  try {
    const stats = await runRiskSync();
    res.json({ ok: true, stats });
  } catch (err) {
    respondWithError(res, err);
  }
});

// ─── Demo-reset endpoints ───────────────────────────────────────────────────
// "Reset demo state" per scenario. Distinct from the /mock-X/reset endpoints,
// which only clear LOCAL mock mutations. These also touch Vanta where possible:
//
//   personnel + devices  full-snapshot PUT semantics → push empty resources to
//                        soft-delete every record, then reset local mock.
//   risk + evidence      no DELETE endpoint exists in Vanta for risk scenarios
//                        or document slots, so we reset local only and return
//                        a manualCleanup flag the dashboard surfaces in a toast.
//
// SAs forking + deploying LlamaLync run demos repeatedly against the same
// sandbox tenant. Without this, every demo accretes records and drift gets
// noisy. With this, a click between demos restores baseline.
app.post('/demo/reset/personnel', async (req, res) => {
  const { clearPersonnelInVanta } = require('./sync/jobs/personnelSync');
  const { _resetMutations } = require('./mockHris');
  try {
    const result = await clearPersonnelInVanta();
    _resetMutations();
    res.json({ ok: true, vantaCleared: true, manualCleanup: false, response: result.response });
  } catch (err) {
    respondWithError(res, err);
  }
});

app.post('/demo/reset/devices', async (req, res) => {
  const { clearDevicesInVanta } = require('./sync/jobs/deviceSync');
  const { _resetMutations } = require('./mockCmdb');
  try {
    const result = await clearDevicesInVanta();
    _resetMutations();
    res.json({ ok: true, vantaCleared: true, manualCleanup: false, responses: result.responses });
  } catch (err) {
    // Partial-failure handling: clearDevicesInVanta attempts macOS and
    // Windows independently. When exactly one platform succeeded the
    // operator's "reset = clean slate" intent has partly landed in Vanta —
    // honor it by clearing local mutations too, but surface the partial
    // Vanta state so the operator can re-click Reset to retry the failed
    // platform's empty-PUT.
    //
    // Why NOT always-reset-in-finally: when both platforms fail (auth issue,
    // env unset, network down), Vanta is unchanged. Resetting local mock
    // anyway would silently force the operator to re-onboard fixture devices
    // for the next demo while Vanta still holds the original records.
    if (err.partial) {
      _resetMutations();
      const failed = [];
      if (err.stats?.failures?.macos)   failed.push('macOS');
      if (err.stats?.failures?.windows) failed.push('Windows');
      return res.status(207).json({
        ok: true,
        vantaCleared: 'partial',
        partial: true,
        manualCleanup: true,
        manualCleanupHint:
          `${err.message} CMDB-X mutations have been reset locally — ` +
          `click Reset again once the upstream issue is resolved to retry the ${failed.join(' + ')} clear.`,
        failedPlatforms: failed,
        stats: err.stats
      });
    }
    respondWithError(res, err);
  }
});

app.post('/demo/reset/risk', async (req, res) => {
  // Risk scenarios in Vanta have no DELETE endpoint — see docs/build-log.md
  // risk slice 4.5 and src/scripts/probeRiskApi.js. Local-only reset; the
  // dashboard surfaces a manualCleanup hint in the toast.
  const { _resetMutations } = require('./mockRiskRegister');
  try {
    _resetMutations();
    res.json({
      ok: true,
      vantaCleared: false,
      manualCleanup: true,
      manualCleanupHint: 'Open Vanta UI → Risk Management and archive any scenarios LlamaLync pushed during this demo. The API exposes isArchived as read-only, so archive can only be triggered from the UI (verified empirically 2026-05-15).'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/demo/reset/evidence', async (req, res) => {
  // Vanta documents are predefined slots; uploaded files persist on the slot
  // and there's no public delete endpoint for them. Local-only reset clears
  // the in-session upload history; Vanta-side cleanup is manual.
  const { _resetUploads } = require('./mockEvidenceStore');
  try {
    _resetUploads();
    res.json({
      ok: true,
      vantaCleared: false,
      manualCleanup: true,
      manualCleanupHint: 'Open Vanta UI → Compliance → Documents to remove evidence files LlamaLync uploaded during this demo. Slot-bound documents have no public DELETE endpoint.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook demo replay — synthesize a signed event and feed it through the
// real receiver pipeline (Svix verify → dedupe → forward to Workflow Sink).
// NO outbound Vanta calls: signed locally with VANTA_WEBHOOK_SECRET, dispatched
// to our own handler. Lets the demo work without waiting for tenant-emitted
// webhooks. Optional `?dedupeTest=true` reuses the last replay's svix-id to
// exercise the at-least-once dedupe path without forwarding a duplicate
// payload downstream.
app.post('/demo/webhook/replay', async (req, res) => {
  const { runReplay } = require('./webhooks/webhookReplay');
  try {
    const dedupeTest = req.query.dedupeTest === 'true';
    const result = await runReplay({ dedupeTest });
    if (!result.ok) {
      return res.status(result.statusCode || 500).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    respondWithError(res, err);
  }
});

// Evidence upload — accepts a JSON body { filename, slotId?, description?,
// effectiveAtDate? }. Single-file primitive matching the Phase 0 finding
// that Vanta documents are predefined slots, not arbitrary uploads. The
// dashboard calls this per row when an operator clicks "Upload to Vanta"
// on a mock evidence file.
app.post('/sync/evidence', express.json({ limit: '8kb' }), async (req, res) => {
  const { runEvidenceUpload } = require('./sync/jobs/evidenceUpload');
  const body = req.body || {};
  try {
    const stats = await runEvidenceUpload({
      filename:        body.filename,
      slotId:          body.slotId || null,
      description:     body.description || null,
      effectiveAtDate: body.effectiveAtDate || null
    });
    res.json({ ok: true, stats });
  } catch (err) {
    respondWithError(res, err);
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`LlamaLync running`, { port: PORT, env: process.env.NODE_ENV });
  logger.info('Endpoints available', {
    dashboard:     `GET  http://localhost:${PORT}/`,
    dashboardJson: `GET  http://localhost:${PORT}/dashboard.json`,
    sourceData:    `GET  http://localhost:${PORT}/mock-peoplex/employees.json`,
    sourceMeta:    `GET  http://localhost:${PORT}/mock-peoplex/_meta.json`,
    riskSource:    `GET  http://localhost:${PORT}/mock-riskx/risks.json`,
    riskMeta:      `GET  http://localhost:${PORT}/mock-riskx/_meta.json`,
    cmdbSource:    `GET  http://localhost:${PORT}/mock-cmdbx/devices.json`,
    cmdbMeta:      `GET  http://localhost:${PORT}/mock-cmdbx/_meta.json`,
    evidenceSource:`GET  http://localhost:${PORT}/mock-evidencex/files.json`,
    evidenceMeta:  `GET  http://localhost:${PORT}/mock-evidencex/_meta.json`,
    health:        `GET  http://localhost:${PORT}/health`,
    webhooks:      `POST http://localhost:${PORT}/webhooks/vanta`,
    syncPersonnel: `POST http://localhost:${PORT}/sync/personnel`,
    syncDevices:   `POST http://localhost:${PORT}/sync/devices`,
    syncVulns:     `POST http://localhost:${PORT}/sync/vulns`,
    syncRisk:      `POST http://localhost:${PORT}/sync/risk`,
    syncEvidence:  `POST http://localhost:${PORT}/sync/evidence`
  });

  // Start all scheduled sync jobs
  startScheduler();
});
