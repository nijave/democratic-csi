const assert = require("node:assert");
const { describe, it, beforeEach, afterEach } = require("node:test");
const { EventEmitter } = require("node:events");
const { ISCSI } = require("../../src/utils/iscsi");

// ISCSI.exec retries individual commands a bounded number of times when
// they time out (`close(null)`), because a timed-out iscsiadm usually lost
// the node-DB lock race to an external holder and every command in the
// stage/unstage sequence is idempotent. Non-timeout failures carry
// actionable stderr and must NOT be retried.

/**
 * Minimal child-process double: EventEmitter with stdout/stderr emitters
 * whose `close` fires after a short delay. `script` is a list of per-call
 * exit codes (last entry repeats); null means "killed by timeout".
 */
function makeFakeExecutor(script, delayMs = 5) {
  const state = { spawnCount: 0 };
  const spawn = function (command, args, options) {
    const index = state.spawnCount++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    setTimeout(() => {
      child.emit("close", script[index] !== undefined ? script[index] : 0);
    }, delayMs);

    return child;
  };
  return { state, executor: { spawn } };
}

function makeIsci(executor) {
  return new ISCSI({ executor });
}

describe("ISCSI.exec timeout retry", () => {
  beforeEach(() => {
    process.env.ISCSIADM_TIMEOUT_RETRIES = "1"; // 1 retry = 2 attempts
  });
  afterEach(() => {
    delete process.env.ISCSIADM_TIMEOUT_RETRIES;
  });

  it("retries a timed-out command and succeeds on the next attempt", async () => {
    const { state, executor } = makeFakeExecutor([null, 0]);
    const iscsi = makeIsci(executor);

    const result = await iscsi.exec("iscsiadm", ["-m", "node", "-l"]);

    assert.strictEqual(result.code, 0);
    assert.strictEqual(state.spawnCount, 2);
  });

  it("rejects after exhausting retries when every attempt times out", async () => {
    const { state, executor } = makeFakeExecutor([null, null]);
    const iscsi = makeIsci(executor);

    await assert.rejects(
      iscsi.exec("iscsiadm", ["-m", "node", "-o", "new"]),
      (err) => err.timeout === true
    );
    assert.strictEqual(state.spawnCount, 2);
  });

  it("respects ISCSIADM_TIMEOUT_RETRIES=0 (single attempt)", async () => {
    process.env.ISCSIADM_TIMEOUT_RETRIES = "0";
    const { state, executor } = makeFakeExecutor([null, 0]);
    const iscsi = makeIsci(executor);

    await assert.rejects(
      iscsi.exec("iscsiadm", ["-m", "node"]),
      (err) => err.timeout === true
    );
    assert.strictEqual(state.spawnCount, 1);
  });

  it("does not retry non-timeout failures", async () => {
    const { state, executor } = makeFakeExecutor([21]);
    const iscsi = makeIsci(executor);

    await assert.rejects(
      iscsi.exec("iscsiadm", ["-m", "node", "-o", "delete"]),
      (err) => err.code === 21
    );
    assert.strictEqual(state.spawnCount, 1);
  });
});
