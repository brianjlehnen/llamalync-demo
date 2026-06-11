const path = require('path');
const fs = require('fs');
const { buildClient } = require('../../http/vantaClient');
const logger = require('../../utils/logger');

const VULNS_FILE = path.join(__dirname, '../../../mock-data/vulnerabilities.json');
const NOT_IMPLEMENTED_MESSAGE = 'Vulnerability sync is scaffolded but disabled until the Vanta vulnerability resource schema is verified.';

function notImplementedError() {
  const err = new Error(NOT_IMPLEMENTED_MESSAGE);
  err.statusCode = 501;
  return err;
}

const SEVERITY_MAP = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW'
};

const STATUS_MAP = {
  open: 'OPEN',
  in_remediation: 'IN_REMEDIATION',
  resolved: 'RESOLVED'
};

function transformVuln(vuln) {
  return {
    externalId: vuln.id,
    title: vuln.title,
    severity: SEVERITY_MAP[vuln.severity] || 'MEDIUM',
    affectedAssetName: vuln.affectedAsset,
    affectedPackageName: vuln.affectedPackage,
    discoveredAt: vuln.discoveredAt,
    remediationDeadline: vuln.slaDeadline,
    status: STATUS_MAP[vuln.status] || 'OPEN',
    cveId: vuln.cveId || null
  };
}

async function runVulnSync() {
  if (process.env.ENABLE_VULN_SYNC !== 'true') throw notImplementedError();

  logger.info('Starting vulnerability sync...');

  const vulns = JSON.parse(fs.readFileSync(VULNS_FILE, 'utf-8'));
  const stats = { synced: 0, errors: 0 };

  for (const vuln of vulns) {
    try {
      const payload = transformVuln(vuln);
      await buildClient.post(
        `/v1/integrations/${process.env.VANTA_INTEGRATION_ID}/resources/vulnerabilities`,
        { resources: [payload] }
      );
      stats.synced++;
      logger.debug('Synced vulnerability', { id: vuln.id, severity: vuln.severity });
    } catch (err) {
      logger.error('Failed to sync vulnerability', { id: vuln.id, error: err.message });
      stats.errors++;
    }
  }

  // After syncing, check for anything approaching SLA breach
  await alertApproachingSLAs(vulns);

  logger.info('Vulnerability sync complete', stats);
  return stats;
}

/**
 * Logs a warning for any vulnerability within 7 days of its SLA deadline.
 * In production you'd send this to Slack, PagerDuty, or email.
 */
async function alertApproachingSLAs(vulns) {
  const now = new Date();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  const approaching = vulns.filter(v => {
    if (v.status === 'resolved') return false;
    const deadline = new Date(v.slaDeadline);
    const msUntilDeadline = deadline - now;
    return msUntilDeadline > 0 && msUntilDeadline <= sevenDaysMs;
  });

  if (approaching.length > 0) {
    logger.warn('Vulnerabilities approaching SLA deadline', {
      count: approaching.length,
      vulns: approaching.map(v => ({
        id: v.id,
        severity: v.severity,
        deadline: v.slaDeadline,
        asset: v.affectedAsset
      }))
    });
  }
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
  runVulnSync().catch(err => {
    logger.error('Vulnerability sync failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = { runVulnSync };
