const assert = require("node:assert");
const { describe, it } = require("node:test");
const { EventEmitter } = require("node:events");
const { ISCSI } = require("../../src/utils/iscsi");

// ISCSI.exec serializes every iscsiadm invocation behind a module-level
// mutex (open-iscsi contends all node-DB ops on one exclusive fcntl lock, so
// a burst of concurrent volumes convoys without it). These tests inject a
// fake executor to assert the serialization, FIFO order, and that a failed
// or never-settling spawn cannot wedge the queue.

/**
 * Minimal child-process double: EventEmitter with stdout/stderr emitters
 * whose `close` fires after a per-call delay.
 *
 * `script` is a list of per-call behaviors (last entry repeats):
 *   { code, delayMs, error } - exit code, settle delay, and/or a spawn
 *   `error` event emitted before close.
 *
 * state.active/maxActive track how many children ran concurrently.
 */
function makeFakeExecutor({ delayMs = 10, script } = {}) {
  const state = { active: 0, maxActive: 0, calls: [], spawnCount: 0 };
  const spawn = function (command, args, options) {
    const index = state.spawnCount++;
    state.calls.push({ command, args, options });
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const behavior = script
      ? script[index] || script[script.length - 1]
      : undefined;
    const settleMs =
      behavior && behavior.delayMs !== undefined ? behavior.delayMs : delayMs;

    setTimeout(() => {
      state.active--;
      if (behavior && behavior.error) {
        child.emit("error", behavior.error);
      }
      child.emit("close", behavior ? behavior.code : 0);
    }, settleMs);

    return child;
  };
  return { state, executor: { spawn } };
}

function makeIsci(executor) {
  return new ISCSI({ executor });
}

describe("ISCSI.exec serialization", () => {
  it("runs concurrent invocations one at a time", async () => {
    const { state, executor } = makeFakeExecutor({ delayMs: 15 });
    const iscsi = makeIsci(executor);

    const calls = [];
    for (let i = 0; i < 8; i++) {
      calls.push(iscsi.exec("iscsiadm", ["-m", "node", "-o", "new", `iqn-${i}`]));
    }
    const results = await Promise.all(calls);

    assert.strictEqual(results.length, 8);
    assert.strictEqual(
      state.maxActive,
      1,
      `expected max 1 concurrent iscsiadm, saw ${state.maxActive}`
    );
  });

  it("preserves FIFO order", async () => {
    const { state, executor } = makeFakeExecutor({ delayMs: 5 });
    const iscsi = makeIsci(executor);

    const calls = [];
    for (let i = 0; i < 6; i++) {
      calls.push(iscsi.exec("iscsiadm", ["arg", String(i)]));
    }
    await Promise.all(calls);

    const order = state.calls.map((call) => call.args[1]);
    assert.deepStrictEqual(order, ["0", "1", "2", "3", "4", "5"]);
  });

  it("a failed command does not block later commands", async () => {
    const { state, executor } = makeFakeExecutor({
      script: [{ code: 1 }, { code: 0 }, { code: 0 }],
    });
    const iscsi = makeIsci(executor);

    const failing = iscsi.exec("iscsiadm", ["-m", "node", "-o", "new", "a"]);
    const succeeding = iscsi.exec("iscsiadm", ["-m", "node", "-o", "new", "b"]);

    await assert.rejects(failing, (err) => err.code === 1);
    await succeeding;
    assert.strictEqual(state.spawnCount, 2);
  });

  it("a spawn error settles the promise and releases the queue", async () => {
    const { state, executor } = makeFakeExecutor({
      script: [{ error: new Error("spawn ENOENT") }, { code: 0 }],
    });
    const iscsi = makeIsci(executor);

    const failing = iscsi.exec("iscsiadm", ["-m", "session"]);
    const succeeding = iscsi.exec("iscsiadm", ["-m", "node"]);

    await assert.rejects(failing, (err) => err.error instanceof Error);
    await succeeding;
    assert.strictEqual(state.spawnCount, 2);
  });
});
