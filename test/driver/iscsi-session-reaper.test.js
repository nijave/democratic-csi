const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  isSessionReapable,
  reconcile,
  STALE_DEVICE_STATES,
} = require("../../src/utils/iscsi-session-reaper");

/**
 * Build a session object shaped like iscsi.iscsiadm.getSessionsDetails() output.
 *
 * devices: [{ name: "sdb", state: "offline" }, ...]
 */
function makeSession({ iqn, portal, devices = [] }) {
  return {
    target: iqn,
    persistent_portal: portal,
    attached_scsi_devices: {
      host: {
        number: "42",
        state: "running",
        devices: devices.map((d) => ({
          channel: "00",
          id: "0",
          lun: "0",
          attached_scsi_disk: d.name,
          state: d.state,
        })),
      },
    },
  };
}

/**
 * Minimal iscsi stub tracking logout / deleteNodeDBEntry calls, mirroring the
 * fakeZb pattern in controller-zfs.test.js.
 *
 * logoutErrors: map of iqn -> error message to throw from logout()
 */
function fakeIscsi({ sessions = [], logoutErrors = {} } = {}) {
  const calls = { getSessionsDetails: 0, logout: [], delete: [] };
  return {
    calls,
    iscsiadm: {
      async getSessionsDetails() {
        calls.getSessionsDetails++;
        return sessions;
      },
      async logout(iqn, portals) {
        calls.logout.push({ iqn, portals });
        if (logoutErrors[iqn]) {
          throw new Error(logoutErrors[iqn]);
        }
        return true;
      },
      async deleteNodeDBEntry(iqn, portal) {
        calls.delete.push({ iqn, portal });
        return true;
      },
    },
  };
}

/**
 * Minimal mount stub. mounted: map of "/dev/sdX" -> boolean.
 */
function fakeMount({ mounted = {} } = {}) {
  return {
    async deviceIsMounted(device) {
      return !!mounted[device];
    },
  };
}

function nullLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

// Records error() calls as util.format would render them, so tests assert on
// the final "%s"-coerced string rather than the raw args.
function spyLogger() {
  const util = require("node:util");
  const errors = [];
  const record = (bucket) => (...args) => bucket.push(util.format(...args));
  return {
    errors,
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: record(errors),
  };
}

/**
 * reconcile() readDeviceState injection: resolve device state from a map,
 * returning null when absent so isSessionReapable falls back to the state
 * embedded in the session detail (mirrors sysfs being unavailable).
 */
function stateReader(deviceStates = {}) {
  return async (dev) =>
    Object.prototype.hasOwnProperty.call(deviceStates, dev)
      ? deviceStates[dev]
      : null;
}

describe("isSessionReapable - conservative detection predicate", () => {
  it("is reapable when ALL devices are offline and none mounted", () => {
    const session = makeSession({
      iqn: "iqn.dead:1",
      portal: "10.0.0.1:3260",
      devices: [{ name: "sdb" }, { name: "sdc" }],
    });
    const result = isSessionReapable(session, {
      deviceStates: { sdb: "offline", sdc: "offline" },
      mounts: { sdb: false, sdc: false },
    });
    assert.strictEqual(result.reapable, true);
  });

  it("treats transport-offline as stale", () => {
    for (const state of STALE_DEVICE_STATES) {
      const session = makeSession({
        iqn: "iqn.dead:1",
        portal: "10.0.0.1:3260",
        devices: [{ name: "sdb" }],
      });
      const result = isSessionReapable(session, {
        deviceStates: { sdb: state },
        mounts: { sdb: false },
      });
      assert.strictEqual(result.reapable, true, `state ${state} should be stale`);
    }
  });

  it("is NOT reapable when ANY device is running", () => {
    const session = makeSession({
      iqn: "iqn.mixed:1",
      portal: "10.0.0.1:3260",
      devices: [{ name: "sdb" }, { name: "sdc" }],
    });
    const result = isSessionReapable(session, {
      deviceStates: { sdb: "offline", sdc: "running" },
      mounts: { sdb: false, sdc: false },
    });
    assert.strictEqual(result.reapable, false);
  });

  it("is NOT reapable when an offline device is still mounted/in-use", () => {
    const session = makeSession({
      iqn: "iqn.busy:1",
      portal: "10.0.0.1:3260",
      devices: [{ name: "sdb" }],
    });
    const result = isSessionReapable(session, {
      deviceStates: { sdb: "offline" },
      mounts: { sdb: true },
    });
    assert.strictEqual(result.reapable, false);
  });

  it("is NOT reapable when a device has unknown state (missing maps)", () => {
    const session = makeSession({
      iqn: "iqn.unknown:1",
      portal: "10.0.0.1:3260",
      devices: [{ name: "sdb", state: undefined }],
    });
    // no deviceStates, no mounts -> unknown state + assumed mounted
    const result = isSessionReapable(session, {});
    assert.strictEqual(result.reapable, false);
  });

  it("is NOT reapable when the session has no attached devices", () => {
    const session = makeSession({
      iqn: "iqn.empty:1",
      portal: "10.0.0.1:3260",
      devices: [],
    });
    const result = isSessionReapable(session, {});
    assert.strictEqual(result.reapable, false);
  });

  it("falls back to the session-embedded device state when maps are empty", () => {
    const session = makeSession({
      iqn: "iqn.fallback:1",
      portal: "10.0.0.1:3260",
      devices: [{ name: "sdb", state: "offline" }],
    });
    const result = isSessionReapable(session, { mounts: { sdb: false } });
    assert.strictEqual(result.reapable, true);
  });
});

describe("reconcile - opt-in gate", () => {
  it("is a complete no-op when disabled (does not even enumerate sessions)", async () => {
    const iscsi = fakeIscsi({
      sessions: [
        makeSession({
          iqn: "iqn.dead:1",
          portal: "10.0.0.1:3260",
          devices: [{ name: "sdb", state: "offline" }],
        }),
      ],
    });
    const summary = await reconcile({
      iscsi,
      mount: fakeMount(),
      logger: nullLogger(),
      config: { enabled: false, minStaleSeconds: 0 },
      staleSince: new Map(),
      readDeviceState: stateReader({ sdb: "offline" }),
    });
    assert.strictEqual(summary.disabled, true);
    assert.strictEqual(iscsi.calls.getSessionsDetails, 0);
    assert.strictEqual(iscsi.calls.logout.length, 0);
    assert.strictEqual(iscsi.calls.delete.length, 0);
  });
});

describe("reconcile - reaping behavior", () => {
  it("reaps a fully-stale, unmounted session (logout + node-DB delete)", async () => {
    const iscsi = fakeIscsi({
      sessions: [
        makeSession({
          iqn: "iqn.dead:1",
          portal: "10.0.0.1:3260",
          devices: [{ name: "sdb", state: "offline" }],
        }),
      ],
    });
    const summary = await reconcile({
      iscsi,
      mount: fakeMount({ mounted: { "/dev/sdb": false } }),
      logger: nullLogger(),
      config: { enabled: true, minStaleSeconds: 0 },
      staleSince: new Map(),
      readDeviceState: stateReader({ sdb: "offline" }),
    });

    assert.strictEqual(iscsi.calls.logout.length, 1);
    assert.deepStrictEqual(iscsi.calls.logout[0], {
      iqn: "iqn.dead:1",
      portals: ["10.0.0.1:3260"],
    });
    assert.strictEqual(iscsi.calls.delete.length, 1);
    assert.deepStrictEqual(iscsi.calls.delete[0], {
      iqn: "iqn.dead:1",
      portal: "10.0.0.1:3260",
    });
    assert.strictEqual(summary.reaped.length, 1);
  });

  it("sysfs state is authoritative over the session-embedded state", async () => {
    // session detail claims running, but sysfs reports offline -> reapable
    const iscsi = fakeIscsi({
      sessions: [
        makeSession({
          iqn: "iqn.dead:1",
          portal: "10.0.0.1:3260",
          devices: [{ name: "sdb", state: "running" }],
        }),
      ],
    });
    const summary = await reconcile({
      iscsi,
      mount: fakeMount(),
      logger: nullLogger(),
      config: { enabled: true, minStaleSeconds: 0 },
      staleSince: new Map(),
      readDeviceState: stateReader({ sdb: "offline" }),
    });
    assert.strictEqual(iscsi.calls.logout.length, 1);
    assert.strictEqual(summary.reaped.length, 1);
  });

  it("does NOT log out a session with a running device", async () => {
    const iscsi = fakeIscsi({
      sessions: [
        makeSession({
          iqn: "iqn.healthy:1",
          portal: "10.0.0.1:3260",
          devices: [{ name: "sdb", state: "running" }],
        }),
      ],
    });
    const summary = await reconcile({
      iscsi,
      mount: fakeMount(),
      logger: nullLogger(),
      config: { enabled: true, minStaleSeconds: 0 },
      staleSince: new Map(),
      readDeviceState: stateReader({ sdb: "running" }),
    });
    assert.strictEqual(iscsi.calls.logout.length, 0);
    assert.strictEqual(iscsi.calls.delete.length, 0);
    assert.strictEqual(summary.reaped.length, 0);
    assert.strictEqual(summary.skipped.length, 1);
  });

  it("does NOT log out an offline session that is still mounted", async () => {
    const iscsi = fakeIscsi({
      sessions: [
        makeSession({
          iqn: "iqn.busy:1",
          portal: "10.0.0.1:3260",
          devices: [{ name: "sdb", state: "offline" }],
        }),
      ],
    });
    const summary = await reconcile({
      iscsi,
      mount: fakeMount({ mounted: { "/dev/sdb": true } }),
      logger: nullLogger(),
      config: { enabled: true, minStaleSeconds: 0 },
      staleSince: new Map(),
      readDeviceState: stateReader({ sdb: "offline" }),
    });
    assert.strictEqual(iscsi.calls.logout.length, 0);
    assert.strictEqual(summary.reaped.length, 0);
    assert.strictEqual(summary.skipped.length, 1);
  });

  it("reaps only the stale session and leaves a healthy session untouched", async () => {
    const iscsi = fakeIscsi({
      sessions: [
        makeSession({
          iqn: "iqn.dead:1",
          portal: "10.0.0.1:3260",
          devices: [{ name: "sdb", state: "offline" }],
        }),
        makeSession({
          iqn: "iqn.healthy:1",
          portal: "10.0.0.2:3260",
          devices: [{ name: "sdc", state: "running" }],
        }),
      ],
    });
    const summary = await reconcile({
      iscsi,
      mount: fakeMount(),
      logger: nullLogger(),
      config: { enabled: true, minStaleSeconds: 0 },
      staleSince: new Map(),
      readDeviceState: stateReader({ sdb: "offline", sdc: "running" }),
    });

    assert.strictEqual(iscsi.calls.logout.length, 1);
    assert.strictEqual(iscsi.calls.logout[0].iqn, "iqn.dead:1");
    assert.strictEqual(summary.reaped.length, 1);
    assert.strictEqual(summary.reaped[0].iqn, "iqn.dead:1");
    // the healthy session was skipped, never logged out
    assert.ok(summary.skipped.some((s) => s.iqn === "iqn.healthy:1"));
  });

  it("logout failure is contained: loop continues and the session is NOT counted reaped", async () => {
    const iscsi = fakeIscsi({
      sessions: [
        makeSession({
          iqn: "iqn.broken:1",
          portal: "10.0.0.1:3260",
          devices: [{ name: "sdb", state: "offline" }],
        }),
        makeSession({
          iqn: "iqn.dead:2",
          portal: "10.0.0.2:3260",
          devices: [{ name: "sdc", state: "offline" }],
        }),
      ],
      logoutErrors: { "iqn.broken:1": "iscsiadm logout blew up" },
    });
    const staleSince = new Map();
    const summary = await reconcile({
      iscsi,
      mount: fakeMount(),
      logger: nullLogger(),
      config: { enabled: true, minStaleSeconds: 0 },
      staleSince,
      readDeviceState: stateReader({ sdb: "offline", sdc: "offline" }),
    });

    // both sessions were attempted (loop did not abort on the first failure)
    assert.strictEqual(iscsi.calls.logout.length, 2);
    // the broken one is reported failed, not reaped
    assert.ok(summary.failed.some((s) => s.iqn === "iqn.broken:1"));
    assert.ok(!summary.reaped.some((s) => s.iqn === "iqn.broken:1"));
    // the good one still got reaped
    assert.ok(summary.reaped.some((s) => s.iqn === "iqn.dead:2"));
    // the failed session's staleness timer is retained (not marked handled)
    assert.ok(staleSince.has("iqn.broken:1|10.0.0.1:3260"));
  });

  it("does not reap until minStaleSeconds has elapsed across passes", async () => {
    const iscsi = fakeIscsi({
      sessions: [
        makeSession({
          iqn: "iqn.dead:1",
          portal: "10.0.0.1:3260",
          devices: [{ name: "sdb", state: "offline" }],
        }),
      ],
    });
    const staleSince = new Map();
    const common = {
      iscsi,
      mount: fakeMount(),
      logger: nullLogger(),
      config: { enabled: true, minStaleSeconds: 120 },
      staleSince,
      readDeviceState: stateReader({ sdb: "offline" }),
    };

    // first pass at t=1000: only records, does not reap
    await reconcile(Object.assign({}, common, { now: 1000 }));
    assert.strictEqual(iscsi.calls.logout.length, 0);
    assert.strictEqual(staleSince.get("iqn.dead:1|10.0.0.1:3260"), 1000);

    // second pass still within the window: still no reap
    await reconcile(Object.assign({}, common, { now: 1060 }));
    assert.strictEqual(iscsi.calls.logout.length, 0);

    // third pass past the window: now reaped
    await reconcile(Object.assign({}, common, { now: 1200 }));
    assert.strictEqual(iscsi.calls.logout.length, 1);
  });

  it("logs the underlying error detail (not [object Object]) when session enumeration fails with an exec-rejection object", async () => {
    const execRejection = {
      code: 21,
      stdout: "",
      stderr: "iscsiadm: could not read session targets: connection refused",
      timeout: false,
    };
    const iscsi = {
      calls: { getSessionsDetails: 0, logout: [], delete: [] },
      iscsiadm: {
        async getSessionsDetails() {
          throw execRejection;
        },
        async logout() {},
        async deleteNodeDBEntry() {},
      },
    };
    const logger = spyLogger();
    const summary = await reconcile({
      iscsi,
      mount: fakeMount(),
      logger,
      config: { enabled: true, minStaleSeconds: 0 },
      staleSince: new Map(),
    });

    // control flow is unchanged: catch-and-continue returns an empty summary
    assert.deepStrictEqual(summary, {
      candidates: [],
      reaped: [],
      failed: [],
      skipped: [],
    });

    assert.strictEqual(logger.errors.length, 1);
    const line = logger.errors[0];
    assert.ok(
      line.includes("failed to enumerate sessions"),
      `expected the enumerate-failure message, got: ${line}`
    );
    assert.ok(
      !line.includes("[object Object]"),
      `error must not string-coerce the raw object, got: ${line}`
    );
    assert.ok(
      line.includes("iscsiadm: could not read session targets"),
      `expected the stderr detail to be surfaced, got: ${line}`
    );
    assert.ok(
      line.includes("code=21"),
      `expected the exit code to be surfaced, got: ${line}`
    );
  });

  it("surfaces the stack/message when session enumeration fails with a real Error", async () => {
    const boom = new Error("iscsid socket unavailable");
    const iscsi = {
      iscsiadm: {
        async getSessionsDetails() {
          throw boom;
        },
        async logout() {},
        async deleteNodeDBEntry() {},
      },
    };
    const logger = spyLogger();
    await reconcile({
      iscsi,
      mount: fakeMount(),
      logger,
      config: { enabled: true, minStaleSeconds: 0 },
      staleSince: new Map(),
    });

    assert.strictEqual(logger.errors.length, 1);
    const line = logger.errors[0];
    assert.ok(!line.includes("[object Object]"), line);
    assert.ok(
      line.includes("iscsid socket unavailable"),
      `expected the Error message, got: ${line}`
    );
    // a real Error carries a stack; assert we logged it (frame reference)
    assert.ok(
      line.includes("iscsi-session-reaper") || line.includes("at "),
      `expected the stack trace to be surfaced, got: ${line}`
    );
  });

  it("resets the staleness timer if a candidate recovers", async () => {
    const staleSince = new Map();
    const offlineSession = makeSession({
      iqn: "iqn.flap:1",
      portal: "10.0.0.1:3260",
      devices: [{ name: "sdb", state: "offline" }],
    });
    const runningSession = makeSession({
      iqn: "iqn.flap:1",
      portal: "10.0.0.1:3260",
      devices: [{ name: "sdb", state: "running" }],
    });

    // observed stale once
    await reconcile({
      iscsi: fakeIscsi({ sessions: [offlineSession] }),
      mount: fakeMount(),
      logger: nullLogger(),
      config: { enabled: true, minStaleSeconds: 120 },
      staleSince,
      now: 1000,
      readDeviceState: stateReader({ sdb: "offline" }),
    });
    assert.ok(staleSince.has("iqn.flap:1|10.0.0.1:3260"));

    // recovers -> timer cleared
    await reconcile({
      iscsi: fakeIscsi({ sessions: [runningSession] }),
      mount: fakeMount(),
      logger: nullLogger(),
      config: { enabled: true, minStaleSeconds: 120 },
      staleSince,
      now: 1060,
      readDeviceState: stateReader({ sdb: "running" }),
    });
    assert.ok(!staleSince.has("iqn.flap:1|10.0.0.1:3260"));
  });
});
