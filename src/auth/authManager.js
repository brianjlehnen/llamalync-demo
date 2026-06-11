const axios = require('axios');
const logger = require('../utils/logger');

const TOKEN_URL = 'https://api.vanta.com/oauth/token';
const REFRESH_BUFFER_SECONDS = 60;

/**
 * Validate an OAuth token response and compute the absolute expiry instant.
 *
 * The previous code assigned `this.token` and `this.expiresAt` directly from
 * `response.data`, then logged via `new Date(this.expiresAt * 1000).toISOString()`.
 * Two failure modes:
 *   - Missing `expires_in` → expiresAt = NaN. `_isTokenValid()`'s falsy check
 *     on `this.expiresAt` correctly treats NaN as invalid, but `getToken()`
 *     then refetches on every call, tripping the OAuth 5/min rate limit.
 *   - NaN expiresAt also crashes `toISOString()` at the log line, surfacing
 *     a misleading "auth failed" error even though the token was acquired.
 *
 * Validate-then-assign: parse + check the response before any mutation, so
 * a malformed response throws cleanly with `this.token`/`this.expiresAt`
 * unchanged. Pure function so callers and tests share the same validation.
 */
function parseTokenResponse(data, now = Date.now()) {
  const accessToken = data?.access_token;
  const expiresIn = Number(data?.expires_in);

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('OAuth response missing access_token');
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OAuth response missing or invalid expires_in');
  }

  return {
    token: accessToken,
    expiresAt: Math.floor(now / 1000) + expiresIn,
    expiresIn
  };
}

/**
 * Manages a single Vanta OAuth client_credentials token for one app.
 *
 * Vanta enforces one active token per app — requesting a new token revokes
 * the previous one and any in-flight calls fail with 401. Each app must own
 * its own AuthManager instance with its own cache.
 */
class AuthManager {
  constructor({ name, clientIdEnv, secretEnv, scope }) {
    this.name = name;
    this.clientIdEnv = clientIdEnv;
    this.secretEnv = secretEnv;
    this.scope = scope;
    this.token = null;
    this.expiresAt = null;
    this._inflight = null;
  }

  async getToken() {
    if (this._isTokenValid()) return this.token;
    // Dedupe concurrent fetches — Vanta enforces one active token per app, so
    // parallel _fetchToken calls would revoke each other's tokens mid-flight
    // and trip the OAuth 5/min rate limit. Share one promise across callers.
    if (this._inflight) return this._inflight;
    this._inflight = this._fetchToken().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  _isTokenValid() {
    if (!this.token || !this.expiresAt) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return nowSeconds < this.expiresAt - REFRESH_BUFFER_SECONDS;
  }

  /**
   * Mark the current token as invalid so the next getToken() refreshes.
   * Call this when a request returns 401 — Vanta has revoked our token
   * (another caller got a fresh one for the same app, per the one-active-
   * token-per-app rule).
   */
  invalidateToken() {
    this.token = null;
    this.expiresAt = null;
  }

  async _fetchToken() {
    logger.debug(`Fetching new Vanta OAuth token (${this.name})...`);

    const clientId = process.env[this.clientIdEnv];
    const clientSecret = process.env[this.secretEnv];
    if (!clientId || !clientSecret) {
      throw new Error(`${this.clientIdEnv} and ${this.secretEnv} must be set in .env`);
    }

    try {
      const response = await axios.post(TOKEN_URL, {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: this.scope
      }, {
        headers: { 'Content-Type': 'application/json' },
        // Without a timeout, a stuck OAuth endpoint hangs the whole dashboard.
        // Token fetches normally return in <1s; 5s gives generous headroom.
        timeout: 5000
      });

      const { token, expiresAt, expiresIn } = parseTokenResponse(response.data);
      this.token = token;
      this.expiresAt = expiresAt;

      logger.info(`OAuth token acquired (${this.name})`, {
        scope: this.scope,
        expiresIn: `${expiresIn}s`,
        expiresAt: new Date(expiresAt * 1000).toISOString()
      });

      return this.token;
    } catch (err) {
      const msg = err.response?.data?.error_description
        || err.response?.data?.error
        || err.message;
      logger.error(`Failed to fetch Vanta OAuth token (${this.name})`, { error: msg });
      throw new Error(`Auth failed (${this.name}): ${msg}`);
    }
  }
}

// Build Integrations app — pushes resources INTO Vanta (custom user accounts,
// devices, vulnerabilities, evidence-document uploads). Required scopes are
// listed in .env.example next to VANTA_BUILD_CLIENT_ID.
//
//   self:write-document + self:read-document added 2026-05-14 for the
//   Evidence scenario (POST /v1/documents/{slug}/uploads, multipart). Build
//   Integrations scopes are app-creation-time in Dev Console; the Phase 0
//   probe (src/scripts/probeDocumentUpload.js) verified both are enabled in
//   our app and that the OAuth token issues cleanly with the expanded set.
const buildAuth = new AuthManager({
  name: 'build',
  clientIdEnv: 'VANTA_BUILD_CLIENT_ID',
  secretEnv: 'VANTA_BUILD_CLIENT_SECRET',
  scope: 'connectors.self:read-resource connectors.self:write-resource self:write-document self:read-document'
});

// Manage Vanta app — reads Vanta-native entities and writes risk scenarios.
//   Read:  /v1/people, /v1/tests, /v1/controls, /v1/vulnerabilities (Compliance tab)
//   Write: /v1/risk-scenarios — POST + PATCH (Risk scenario)
// Person upsert/offboard via API is still NOT supported by Vanta; offboarding
// continues to be handled by full-snapshot PUT semantics on the Build side.
const manageAuth = new AuthManager({
  name: 'manage',
  clientIdEnv: 'VANTA_MANAGE_CLIENT_ID',
  secretEnv: 'VANTA_MANAGE_CLIENT_SECRET',
  scope: 'vanta-api.all:read vanta-api.all:write'
});

module.exports = { AuthManager, buildAuth, manageAuth, parseTokenResponse };
