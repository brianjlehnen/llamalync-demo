/**
 * Process-wide mutual-exclusion locks for full-snapshot sync jobs.
 *
 * Both the cron scheduler AND the manual `POST /sync/*` routes trigger the
 * same sync functions, and Vanta's Build Integrations sync endpoints use
 * full-snapshot PUT semantics — two concurrent runs against the same
 * resource race the same record set and the one-active-token-per-app rule
 * means the second run's OAuth refresh revokes the first run's token
 * mid-flight (see scheduler.js header for the original incident write-up).
 *
 * The lock is keyed by job name (`personnel`, `devices`, etc.) so different
 * resource families can still run concurrently — a Devices sync does not
 * need to wait for a Personnel sync, because they target independent
 * Vanta resources and use independent OAuth tokens.
 *
 * Lock state is module-level so every importer shares the same Map. The
 * scheduler-only `withOverlapGuard` it replaced kept state in a closure
 * per call, which meant the scheduler couldn't see a manual route's
 * in-flight sync (and vice versa).
 *
 * Contract:
 *   - If the lock is free, run `fn`, resolve to its return value, release
 *     the lock in finally.
 *   - If the lock is held, throw `SyncBusyError` immediately — do NOT
 *     queue, do NOT wait. Caller decides whether to surface 409 (route)
 *     or just log+return (scheduler tick).
 */

class SyncBusyError extends Error {
  constructor(name) {
    super(`Sync '${name}' is already running`);
    this.name = 'SyncBusyError';
    this.code = 'SYNC_BUSY';
    this.statusCode = 409;
    this.lockName = name;
  }
}

const running = new Map();

async function runWithSyncLock(name, fn) {
  if (running.get(name)) {
    throw new SyncBusyError(name);
  }
  running.set(name, true);
  try {
    return await fn();
  } finally {
    running.set(name, false);
  }
}

function isLocked(name) {
  return !!running.get(name);
}

// Test-only: reset the entire lock table. Production code should never
// call this — locks are designed to outlive a single sync invocation.
function _resetAllLocks() {
  running.clear();
}

module.exports = {
  runWithSyncLock,
  isLocked,
  SyncBusyError,
  _resetAllLocks
};
