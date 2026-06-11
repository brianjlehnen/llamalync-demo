const cron = require('node-cron');
const logger = require('../utils/logger');
const { runPersonnelSync } = require('../sync/jobs/personnelSync');
const { runWithSyncLock, SyncBusyError } = require('../utils/syncLocks');

/**
 * Wraps a sync job with logging and error handling so a failure
 * in one job doesn't crash the scheduler or affect other jobs.
 *
 * The lock is acquired via `runWithSyncLock(name, ...)` — shared with the
 * manual `POST /sync/*` routes, so a scheduled tick that fires while an
 * operator-triggered sync is still mid-flight (or vice versa) is detected
 * and skipped rather than racing the same Vanta resource. See
 * src/utils/syncLocks.js for the design rationale.
 *
 * Personnel sync uses Vanta's full-snapshot PUT semantics, so two concurrent
 * runs would race over the same user_account resource — last-write wins,
 * mid-run mutations from the dashboard could be partially lost, and the
 * one-active-token-per-app rule means the second run's OAuth refresh
 * revokes the first run's token mid-flight. None of that is hypothetical:
 * a sync that exceeds its cron interval (rate-limit backoff + a large
 * employee set easily hits this) collides with the next tick.
 */
async function runJob(name, syncFn) {
  logger.info(`[Scheduler] Starting job: ${name}`);
  const startTime = Date.now();
  try {
    const stats = await runWithSyncLock(name, syncFn);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[Scheduler] Job complete: ${name}`, { duration: `${duration}s`, ...stats });
  } catch (err) {
    if (err instanceof SyncBusyError) {
      // Manual route is mid-flight, or the prior tick is still running.
      // Skip cleanly — next tick after release runs normally. No queue.
      logger.warn(`[Scheduler] Skipping ${name} — sync already running`);
      return;
    }
    logger.error(`[Scheduler] Job failed: ${name}`, { error: err.message });
  }
}

function startScheduler() {
  const schedulerEnabled = process.env.NODE_ENV === 'production'
    || process.env.ENABLE_SCHEDULER === 'true';

  if (!schedulerEnabled) {
    logger.info('[Scheduler] Disabled. Set ENABLE_SCHEDULER=true to enable scheduled syncs outside production.');
    return;
  }

  const personnelSchedule = process.env.CRON_PERSONNEL || '0 * * * *';

  logger.info('[Scheduler] Registering sync jobs', {
    personnel: personnelSchedule
  });

  // Personnel: hourly. The shared sync lock means a run that exceeds the
  // cron interval (rate-limit backoff + large employee set) can't race
  // the next tick, AND a manual `POST /sync/personnel` from the dashboard
  // can't race a scheduled tick mid-flight.
  cron.schedule(personnelSchedule, () => runJob('personnel', runPersonnelSync));

  logger.info('[Scheduler] Jobs registered. Device and vulnerability syncs are scaffolded but disabled until their Vanta schemas are verified.');

  // Startup sync removed deliberately: when Vanta has transient OAuth/API
  // issues, an immediate sync just burns quota with retries and the demo
  // server takes minutes to become useful. Cron-only avoids that. Trigger
  // a manual sync via `npm run sync:personnel` or `POST /sync/personnel`
  // when you want immediate data.
}

module.exports = { startScheduler, runJob };
