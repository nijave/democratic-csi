const assert = require("node:assert");
const { describe, it, beforeEach, afterEach } = require("node:test");
const { EventEmitter } = require("node:events");
const { ISCSI } = require("../../src/utils/iscsi");

// node's spawn timeout only sends killSignal (SIGTERM) with no escalation.
// A child that ignores SIGTERM never emits `close`, the exec promise never
// settles, and the module-level mutex wedges every iscsiadm op in the
// process. ISCSI.exec arms a fallback timer (spawn timeout + grace, env
// ISCSIADM_KILL_GRACE_MS) that SIGKILLs the child so it is reaped and the
// queue drains. These tests inject a fake executor whose children ignore
// everything except SIGKILL.

/**
 * Minimal child-process double: EventEmitter with stdout/stderr emitters
 * and a `kill` that records signals.
 *
 * `script` is a list of per-call behaviors (last entry repeats):
 *   { hang: true }           - never closes on its own; closes with code
 *                              null (killed by signal) only on SIGKILL
 *   { code, delayMs }        - closes normally after delayMs (default 5)
 */
function makeFakeExecutor(script) {
  const state = { spawnCount: 0, children: [] };
  const spawn = function (command, args, options) {
    const index = state.spawnCount++;
    const behavior =
      script[index] !== undefined ? script[index] : script[script.length - 1];

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kills = [];
    child.kill = function (signal) {
      child.kills.push(signal);
      // a stuck child ignores everything except SIGKILL; on SIGKILL the
      // kernel reaps it and close fires with code null (killed by signal)
      if (behavior.hang && signal === "SIGKILL") {
        setImmediate(() => child.emit("close", null));
      }
      return true;
    };
    state.children.push(child);

    if (!behavior.hang) {
      setTimeout(
        () => {
          child.emit("close", behavior.code !== undefined ? behavior.code : 0);
        },
        behavior.delayMs !== undefined ? behavior.delayMs : 5
      );
    }

    return child;
  };
  return { state, executor: { spawn } };
}

function makeIsci(executor) {
  return new ISCSI({ executor });
}

describe("ISCSI.exec SIGKILL escalation", () => {
  beforeEach(() => {
    process.env.ISCSIADM_TIMEOUT_RETRIES = "0"; // single attempt
    process.env.ISCSIADM_KILL_GRACE_MS = "20";
  });
  afterEach(() => {
    delete process.env.ISCSIADM_TIMEOUT_RETRIES;
    delete process.env.ISCSIADM_KILL_GRACE_MS;
  });

  it("SIGKILLs a child that survives the spawn timeout and rejects as a timeout", async () => {
    const { state, executor } = makeFakeExecutor([{ hang: true }]);
    const iscsi = makeIsci(executor);

    await assert.rejects(
      iscsi.exec("iscsiadm", ["-m", "session"], { timeout: 30 }),
      (err) => err.timeout === true
    );
    assert.deepStrictEqual(state.children[0].kills, ["SIGKILL"]);
  });

  it("releases the mutex after reaping a stuck child so queued execs proceed", async () => {
    const { state, executor } = makeFakeExecutor([{ hang: true }, { code: 0 }]);
    const iscsi = makeIsci(executor);

    const hung = iscsi.exec("iscsiadm", ["-m", "node", "-T", "iqn-a"], {
      timeout: 30,
    });
    const queued = iscsi.exec("iscsiadm", ["-m", "node", "-T", "iqn-b"], {
      timeout: 30,
    });

    await assert.rejects(hung, (err) => err.timeout === true);
    const result = await queued;

    assert.strictEqual(result.code, 0);
    assert.strictEqual(state.spawnCount, 2);
  });

  it("a reaped stuck child counts as a timeout and is retried", async () => {
    process.env.ISCSIADM_TIMEOUT_RETRIES = "1"; // 1 retry = 2 attempts
    const { state, executor } = makeFakeExecutor([{ hang: true }, { code: 0 }]);
    const iscsi = makeIsci(executor);

    const result = await iscsi.exec("iscsiadm", ["-m", "node", "-l"], {
      timeout: 30,
    });

    assert.strictEqual(result.code, 0);
    assert.strictEqual(state.spawnCount, 2);
    assert.deepStrictEqual(state.children[0].kills, ["SIGKILL"]);
    assert.deepStrictEqual(state.children[1].kills, []);
  });

  it("clears the escalation timer on normal close (no stray SIGKILL)", async () => {
    const { state, executor } = makeFakeExecutor([{ code: 0, delayMs: 5 }]);
    const iscsi = makeIsci(executor);

    const result = await iscsi.exec("iscsiadm", ["-m", "session"], {
      timeout: 30,
    });
    assert.strictEqual(result.code, 0);

    // wait past timeout + grace; a leaked timer would have fired by now
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepStrictEqual(state.children[0].kills, []);
  });
});
