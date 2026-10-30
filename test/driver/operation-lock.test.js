const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  OperationLock,
  DEFAULT_MAX_HOLD_MS,
} = require("../../src/utils/operation_lock");

function clock(start = 1000) {
  const c = { t: start };
  c.now = () => c.t;
  return c;
}

function recordingLogger() {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args) };
}

describe("OperationLock", () => {
  it("blocks a second acquisition of any held key", () => {
    const lock = new OperationLock({ maxHoldMs: 0 });
    const t1 = lock.acquire(["create_volume_name_pvc-a"], "CreateVolume");
    assert.notStrictEqual(t1, null);
    assert.strictEqual(lock.acquire(["create_volume_name_pvc-a"]), null);
    assert.strictEqual(
      lock.acquire(["create_snapshot_name_s", "create_volume_name_pvc-a"]),
      null
    );
    // a partial conflict must not leave the free key held
    assert.strictEqual(lock.has("create_snapshot_name_s"), false);
    // unrelated keys are unaffected
    assert.notStrictEqual(lock.acquire(["create_volume_name_pvc-b"]), null);
  });

  it("releases keys so the next request can acquire them", () => {
    const lock = new OperationLock({ maxHoldMs: 0 });
    const keys = ["volume_id_a", "create_snapshot_name_s"];
    const t1 = lock.acquire(keys);
    lock.release(keys, t1);
    assert.strictEqual(lock.has("volume_id_a"), false);
    assert.notStrictEqual(lock.acquire(keys), null);
  });

  it("never evicts when maxHoldMs is 0", () => {
    const c = clock();
    const lock = new OperationLock({ maxHoldMs: 0, now: c.now });
    lock.acquire(["k"]);
    c.t += 365 * 24 * 60 * 60 * 1000;
    assert.strictEqual(lock.acquire(["k"]), null);
  });

  it("evicts a key held longer than maxHoldMs and logs it", () => {
    const c = clock();
    const logger = recordingLogger();
    const lock = new OperationLock({ maxHoldMs: 1000, now: c.now, logger });
    const stale = lock.acquire(["k"], "CreateVolume");

    c.t += 999;
    assert.strictEqual(lock.acquire(["k"]), null);
    assert.strictEqual(logger.warnings.length, 0);

    c.t += 1;
    const fresh = lock.acquire(["k"], "CreateVolume");
    assert.notStrictEqual(fresh, null);
    assert.notStrictEqual(fresh, stale);
    assert.strictEqual(logger.warnings.length, 1);
    assert.match(logger.warnings[0][0], /evicting stale operation lock/);
  });

  it("a stale holder finishing late does not release the new holder", () => {
    const c = clock();
    const lock = new OperationLock({ maxHoldMs: 1000, now: c.now });
    const stale = lock.acquire(["k"]);
    c.t += 5000;
    const fresh = lock.acquire(["k"]);

    // the hung handler finally returns and runs its finally block
    lock.release(["k"], stale);
    assert.strictEqual(lock.has("k"), true);
    assert.strictEqual(lock.acquire(["k"]), null);

    lock.release(["k"], fresh);
    assert.strictEqual(lock.has("k"), false);
  });

  it("reads maxHoldMs from OPERATION_LOCK_MAX_HOLD_MS", () => {
    const prev = process.env.OPERATION_LOCK_MAX_HOLD_MS;
    try {
      delete process.env.OPERATION_LOCK_MAX_HOLD_MS;
      assert.strictEqual(new OperationLock().maxHoldMs, DEFAULT_MAX_HOLD_MS);
      assert.strictEqual(DEFAULT_MAX_HOLD_MS, 30 * 60 * 1000);
      process.env.OPERATION_LOCK_MAX_HOLD_MS = "60000";
      assert.strictEqual(new OperationLock().maxHoldMs, 60000);
      process.env.OPERATION_LOCK_MAX_HOLD_MS = "0";
      assert.strictEqual(new OperationLock().maxHoldMs, 0);
      process.env.OPERATION_LOCK_MAX_HOLD_MS = "nope";
      assert.strictEqual(new OperationLock().maxHoldMs, DEFAULT_MAX_HOLD_MS);
      assert.strictEqual(new OperationLock({ maxHoldMs: 7 }).maxHoldMs, 7);
    } finally {
      if (prev === undefined) {
        delete process.env.OPERATION_LOCK_MAX_HOLD_MS;
      } else {
        process.env.OPERATION_LOCK_MAX_HOLD_MS = prev;
      }
    }
  });
});
