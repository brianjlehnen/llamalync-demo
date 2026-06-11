const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { buildAuth, manageAuth } = require('../auth/authManager');
const logger = require('../utils/logger');

function mask(token) {
  if (!token) return '<none>';
  return `${token.slice(0, 6)}…${token.slice(-4)} (len=${token.length})`;
}

async function probe(auth) {
  if (!process.env[auth.clientIdEnv] || !process.env[auth.secretEnv]) {
    throw new Error(`Missing env vars for ${auth.name}: ${auth.clientIdEnv} / ${auth.secretEnv}`);
  }

  const t0 = Date.now();
  const cold = await auth.getToken();
  const coldMs = Date.now() - t0;

  const t1 = Date.now();
  const warm = await auth.getToken();
  const warmMs = Date.now() - t1;

  return {
    name: auth.name,
    scope: auth.scope,
    tokenPreview: mask(cold),
    cachedSecondCall: cold === warm,
    coldFetchMs: coldMs,
    warmFetchMs: warmMs,
    expiresAt: new Date(auth.expiresAt * 1000).toISOString(),
    ttlSeconds: auth.expiresAt - Math.floor(Date.now() / 1000)
  };
}

async function main() {
  // Sequential, not parallel — two different apps have independent token caches,
  // but sequential output is easier to read and matches how the runtime callers
  // actually consume tokens.
  const buildResult = await probe(buildAuth);
  logger.info('Auth smoke-test passed (build)', buildResult);

  const manageResult = await probe(manageAuth);
  logger.info('Auth smoke-test passed (manage)', manageResult);
}

main().catch(err => {
  logger.error('Auth smoke-test failed', { error: err.message });
  process.exit(1);
});
