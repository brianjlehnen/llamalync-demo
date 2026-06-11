const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { runJob } = require('../src/scheduler/scheduler');
const {
  runWithSyncLock,
  isLocked,
  _resetAllLocks
} = require('../src/utils/syncLocks');

// Manually-controlled promise so tests can interleave invocations
// deterministically without timers.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('scheduler.runJob', () => {
  beforeEach(() => {
    _resetAllLocks();
  });

  test('invokes the sync function and releases the shared lock', async () => {
    let calls = 0;
    await runJob('personnel', async () => { calls++; return { pushed: 3 }; });
    assert.strictEqual(calls, 1);
    assert.strictEqual(isLocked('personnel'), false);
  });

  test('a scheduled tick fired while a manual sync holds the same lock is skipped, not queued', async () => {
    // Simulates: operator clicks Sync Now → POST /sync/personnel acquires
    // the personnel lock → cron tick fires partway through. The scheduler
    // must skip cleanly, not retry, not queue.
    const d = deferred();
    const manualPromise = runWithSyncLock('personnel', async () => { await d.promise; });

    let scheduledRan = false;
    await runJob('personnel', async () => { scheduledRan = true; });

    assert.strictEqual(scheduledRan, false, 'scheduled job did not race the manual sync');

    // After manual sync releases, a subsequent tick runs normally.
    d.resolve();
    await manualPromise;
    assert.strictEqual(isLocked('personnel'), false);

    await runJob('personnel', async () => { scheduledRan = true; });
    assert.strictEqual(scheduledRan, true);
  });

  test('a scheduled tick fired while a DIFFERENT lock is held still runs', async () => {
    // Devices and personnel are independent locks — a devices sync mid-flight
    // must not block the hourly personnel tick.
    const d = deferred();
    const devicesPromise = runWithSyncLock('devices', async () => { await d.promise; });

    let personnelRan = false;
    await runJob('personnel', async () => { personnelRan = true; });
    assert.strictEqual(personnelRan, true);

    d.resolve();
    await devicesPromise;
  });

  test('a sync error is caught and does NOT leak the lock', async () => {
    await runJob('personnel', async () => { throw new Error('vanta exploded'); });
    assert.strictEqual(isLocked('personnel'), false);

    // Lock released → next tick runs normally.
    let ran = false;
    await runJob('personnel', async () => { ran = true; });
    assert.strictEqual(ran, true);
  });

  test('runJob never throws — sync errors stay inside (scheduler stability)', async () => {
    // The cron callback is fire-and-forget; an uncaught throw inside the
    // scheduler tick would surface as an unhandled rejection and could
    // crash the process under strict node flags.
    await assert.doesNotReject(
      runJob('personnel', async () => { throw new Error('boom'); })
    );
  });
});
