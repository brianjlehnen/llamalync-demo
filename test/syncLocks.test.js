const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  runWithSyncLock,
  isLocked,
  SyncBusyError,
  _resetAllLocks
} = require('../src/utils/syncLocks');

// Manually-controlled promise so tests can interleave invocations
// deterministically without timers.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('runWithSyncLock', () => {
  beforeEach(() => {
    // Lock state is module-level by design (shared across scheduler + routes),
    // so each test resets it explicitly. Without this, an earlier test leaving
    // a lock held would cascade into later tests.
    _resetAllLocks();
  });

  test('runs work when the lock is free and resolves to its return value', async () => {
    const result = await runWithSyncLock('personnel', async () => 42);
    assert.strictEqual(result, 42);
    assert.strictEqual(isLocked('personnel'), false);
  });

  test('throws SyncBusyError when the lock is already held', async () => {
    const d = deferred();
    const first = runWithSyncLock('personnel', async () => { await d.promise; });

    await assert.rejects(
      runWithSyncLock('personnel', async () => 'should never run'),
      err => err instanceof SyncBusyError
        && err.code === 'SYNC_BUSY'
        && err.statusCode === 409
        && err.lockName === 'personnel'
    );

    d.resolve();
    await first;
  });

  test('releases the lock after work completes — next call runs', async () => {
    let calls = 0;
    await runWithSyncLock('personnel', async () => { calls++; });
    await runWithSyncLock('personnel', async () => { calls++; });
    assert.strictEqual(calls, 2);
    assert.strictEqual(isLocked('personnel'), false);
  });

  test('releases the lock when work throws', async () => {
    await assert.rejects(
      runWithSyncLock('personnel', async () => { throw new Error('boom'); }),
      /boom/
    );
    assert.strictEqual(isLocked('personnel'), false);
    // Lock is released so a follow-up call succeeds.
    const result = await runWithSyncLock('personnel', async () => 'ok');
    assert.strictEqual(result, 'ok');
  });

  test('different lock names are independent', async () => {
    // The lock is shared across scheduler + routes BY NAME — personnel and
    // devices target independent Vanta resources, so they must be allowed
    // to run concurrently.
    const dPersonnel = deferred();
    const dDevices   = deferred();

    const personnel = runWithSyncLock('personnel', async () => { await dPersonnel.promise; });
    const devices   = runWithSyncLock('devices',   async () => { await dDevices.promise; });

    assert.strictEqual(isLocked('personnel'), true);
    assert.strictEqual(isLocked('devices'),   true);

    // While both are running, the contention is per-name only.
    await assert.rejects(runWithSyncLock('personnel', async () => null), SyncBusyError);
    await assert.rejects(runWithSyncLock('devices',   async () => null), SyncBusyError);

    dPersonnel.resolve();
    dDevices.resolve();
    await Promise.all([personnel, devices]);
  });

  test('parallel busy callers all see SyncBusyError; first caller completes normally', async () => {
    const d = deferred();
    const first = runWithSyncLock('personnel', async () => {
      await d.promise;
      return 'done';
    });

    const busies = await Promise.allSettled([
      runWithSyncLock('personnel', async () => 'never'),
      runWithSyncLock('personnel', async () => 'never'),
      runWithSyncLock('personnel', async () => 'never')
    ]);
    for (const r of busies) {
      assert.strictEqual(r.status, 'rejected');
      assert.ok(r.reason instanceof SyncBusyError);
    }

    d.resolve();
    assert.strictEqual(await first, 'done');
    assert.strictEqual(isLocked('personnel'), false);
  });

  test('synchronous work function still respects the lock', async () => {
    // Not the common case, but the helper accepts any function returning
    // a thenable or a value; node awaits both. Confirm the lock releases.
    await runWithSyncLock('personnel', () => 'sync-result');
    assert.strictEqual(isLocked('personnel'), false);
  });

  test('SyncBusyError carries a human-readable message including the lock name', () => {
    const err = new SyncBusyError('devices');
    assert.match(err.message, /devices/);
    assert.strictEqual(err.name, 'SyncBusyError');
  });
});
