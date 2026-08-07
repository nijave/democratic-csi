const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  findIscsiSessionForVolumeId,
  logoutAndDeleteTarget,
  stagingDeviceIsDead,
  reclaimDeadIscsiSession,
  iscsiadmUnusable,
  disconnectNvmeByNQN,
} = require("../../src/driver/index");
const { grpc } = require("../../src/utils/grpc");

const VOLUME_ID = "pvc-8c49880-7201-497c-9cc2-88ebf967daac";
const IQN = `iqn.2025-04.info.example.homelab:ubthv01:${VOLUME_ID}`;
const PORTAL = "10.0.0.1:3260";
const NQN = `nqn.2025-04.info.example.homelab:ubthv01:${VOLUME_ID}`;

function session(target, portal = PORTAL) {
  return { target, persistent_portal: portal };
}

function isUnknown(err) {
  return err && err.code === grpc.status.UNKNOWN;
}

// spy logger that records every message
function spyLogger() {
  const messages = { warn: [], info: [], debug: [], error: [] };
  return {
    messages,
    warn: (m) => messages.warn.push(String(m)),
    info: (m) => messages.info.push(String(m)),
    debug: (m) => messages.debug.push(String(m)),
    error: (m) => messages.error.push(String(m)),
  };
}

/**
 * Stateful iscsiadm fake whose SESSION and NODE-DB record state are tracked
 * independently of the command exit codes, so tests can model iscsiadm's real
 * quirk: a command may error while the state is already gone, or "succeed"
 * while the state persists.
 */
function fakeIscsiadm({
  sessions = [],
  logoutThrows = false,
  logoutRemovesSession = true,
  deleteThrows = false,
  deleteRemovesEntry = true,
} = {}) {
  const calls = {
    logout: [],
    deleteNodeDBEntry: [],
    getSessionsDetails: 0,
    getSession: [],
    nodeDBEntryExists: [],
  };
  const key = (t, p) => `${t}|${p}`;
  let liveSessions = sessions.slice();
  const dbEntries = new Set(
    sessions.map((s) => key(s.target, s.persistent_portal))
  );

  return {
    calls,
    peekSessions: () => liveSessions.slice(),
    peekDB: () => new Set(dbEntries),
    async getSessionsDetails() {
      calls.getSessionsDetails++;
      return liveSessions.slice();
    },
    async getSession(target, portal) {
      calls.getSession.push({ target, portal });
      return (
        liveSessions.find(
          (s) => s.target === target && s.persistent_portal === portal
        ) || false
      );
    },
    async logout(target, portals) {
      calls.logout.push({ target, portals });
      if (logoutRemovesSession) {
        liveSessions = liveSessions.filter((s) => s.target !== target);
      }
      if (logoutThrows) throw new Error("iscsiadm-logout-boom");
    },
    async deleteNodeDBEntry(target, portal) {
      calls.deleteNodeDBEntry.push({ target, portal });
      if (deleteRemovesEntry) dbEntries.delete(key(target, portal));
      if (deleteThrows) throw new Error("iscsiadm-delete-boom");
    },
    async nodeDBEntryExists(target, portal) {
      calls.nodeDBEntryExists.push({ target, portal });
      return dbEntries.has(key(target, portal));
    },
  };
}

// deps with an instant re-check so the fail-fast path is deterministic in tests
function deps(iscsiadm, logger) {
  return { iscsiadm, sleep: async () => {}, recheckDelayMs: 0, logger };
}

function deadDeps({
  device = "/dev/sdb",
  deviceExists = true,
  stateFileExists = true,
  state = "running",
  getMountPointDevice,
} = {}) {
  return {
    mount: {
      async getMountPointDevice(p) {
        if (getMountPointDevice) return getMountPointDevice(p);
        return device;
      },
    },
    filesystem: {
      async pathExists(p) {
        if (p === device) return deviceExists;
        if (p.startsWith("/sys/block/")) return stateFileExists;
        return false;
      },
      async realpath(p) {
        return p;
      },
      async getBlockDeviceParent() {
        return null;
      },
    },
    readFile: async () => state,
  };
}

// nvmeof fake: disconnect optionally clears the subsystem, getSubsystemByNQN
// reflects live state (undefined == gone, mirroring the real helper)
function fakeNvmeof({ subsystems = [], disconnectRemoves = true } = {}) {
  const calls = { disconnectByNQN: [], getSubsystemByNQN: [] };
  let live = new Set(subsystems);
  return {
    calls,
    async disconnectByNQN(nqn) {
      calls.disconnectByNQN.push(nqn);
      if (disconnectRemoves) live.delete(nqn);
    },
    async getSubsystemByNQN(nqn) {
      calls.getSubsystemByNQN.push(nqn);
      return live.has(nqn) ? { SubsystemNQN: nqn } : undefined;
    },
  };
}

describe("findIscsiSessionForVolumeId", () => {
  it("matches the session whose target IQN contains the volume_id", () => {
    const sessions = [
      session("iqn.2025-04.info.example.homelab:ubthv01:pvc-other"),
      session(IQN),
      session("iqn.2025-04.info.example.homelab:ubthv01:pvc-another"),
    ];
    const matches = findIscsiSessionForVolumeId(sessions, VOLUME_ID);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].target, IQN);
  });

  it("matches every session for a multipath volume", () => {
    const sessions = [
      session(IQN, "10.0.0.1:3260"),
      session(IQN, "10.0.0.2:3260"),
    ];
    assert.strictEqual(
      findIscsiSessionForVolumeId(sessions, VOLUME_ID).length,
      2
    );
  });

  it("returns nothing when no session matches", () => {
    const sessions = [
      session("iqn.2025-04.info.example.homelab:ubthv01:pvc-nope"),
    ];
    assert.deepStrictEqual(findIscsiSessionForVolumeId(sessions, VOLUME_ID), []);
  });

  it("is defensive about bad input", () => {
    assert.deepStrictEqual(findIscsiSessionForVolumeId(null, VOLUME_ID), []);
    assert.deepStrictEqual(findIscsiSessionForVolumeId([], VOLUME_ID), []);
    assert.deepStrictEqual(findIscsiSessionForVolumeId([session(IQN)], ""), []);
    assert.deepStrictEqual(
      findIscsiSessionForVolumeId([{ notarget: true }], VOLUME_ID),
      []
    );
  });
});

describe("stagingDeviceIsDead", () => {
  it("reports dead when the mount source device no longer exists", async () => {
    assert.strictEqual(
      await stagingDeviceIsDead(deadDeps({ deviceExists: false }), "/staging"),
      true
    );
  });

  it("reports dead when the SCSI transport state is offline", async () => {
    for (const state of ["offline", "transport-offline"]) {
      assert.strictEqual(
        await stagingDeviceIsDead(deadDeps({ state }), "/staging"),
        true,
        `expected dead for state=${state}`
      );
    }
  });

  it("reports NOT dead for a running device (healthy-busy mount preserved)", async () => {
    assert.strictEqual(
      await stagingDeviceIsDead(deadDeps({ state: "running" }), "/staging"),
      false
    );
  });

  it("reports NOT dead (inconclusive) when the mount source cannot be resolved", async () => {
    const dead = await stagingDeviceIsDead(
      deadDeps({
        getMountPointDevice: async () => {
          throw new Error("findmnt timeout");
        },
      }),
      "/staging"
    );
    assert.strictEqual(dead, false);
  });
});

describe("logoutAndDeleteTarget - logout decided by session state, not exit code", () => {
  it("treats logout as SUCCESS when the command ERRORS but getSession shows the session gone", async () => {
    const iscsiadm = fakeIscsiadm({
      sessions: [session(IQN)],
      logoutThrows: true,
      logoutRemovesSession: true,
    });
    await assert.doesNotReject(
      logoutAndDeleteTarget(deps(iscsiadm, spyLogger()), IQN, PORTAL)
    );
    assert.strictEqual(iscsiadm.calls.logout.length, 1);
    assert.ok(iscsiadm.calls.getSession.length >= 1);
  });

  it("fails fast: attempts logout once (+one short re-check), not a long loop, then returns a retryable error when the session persists", async () => {
    const iscsiadm = fakeIscsiadm({
      sessions: [session(IQN)],
      logoutThrows: true,
      logoutRemovesSession: false,
    });
    const logger = spyLogger();
    await assert.rejects(
      logoutAndDeleteTarget(deps(iscsiadm, logger), IQN, PORTAL),
      isUnknown
    );
    // the CO drives retries: logout is attempted exactly once, no 30s loop
    assert.strictEqual(iscsiadm.calls.logout.length, 1);
    assert.strictEqual(iscsiadm.peekSessions().length, 1);
    // underlying logout error is LOGGED, not silently swallowed
    assert.ok(
      logger.messages.warn.some((m) => m.includes("iscsiadm-logout-boom")),
      "expected the underlying logout error to be logged"
    );
  });

  it("throws when logout 'succeeds' (exit 0) but a session still remains", async () => {
    const iscsiadm = fakeIscsiadm({
      sessions: [session(IQN)],
      logoutThrows: false,
      logoutRemovesSession: false,
    });
    const logger = spyLogger();
    await assert.rejects(
      logoutAndDeleteTarget(deps(iscsiadm, logger), IQN, PORTAL),
      isUnknown
    );
    assert.strictEqual(iscsiadm.calls.logout.length, 1);
    assert.ok(
      logger.messages.warn.some((m) =>
        m.includes("returned success but state still persists")
      )
    );
  });
});

describe("logoutAndDeleteTarget - node-DB delete decided by record state", () => {
  it("treats delete as SUCCESS when the command ERRORS but the record is gone", async () => {
    const iscsiadm = fakeIscsiadm({
      sessions: [session(IQN)],
      deleteThrows: true,
      deleteRemovesEntry: true,
    });
    await assert.doesNotReject(
      logoutAndDeleteTarget(deps(iscsiadm, spyLogger()), IQN, PORTAL)
    );
    assert.strictEqual(iscsiadm.calls.deleteNodeDBEntry.length, 1);
    assert.ok(iscsiadm.calls.nodeDBEntryExists.length >= 1);
    assert.strictEqual(iscsiadm.peekDB().size, 0);
  });

  it("FAILS FAST (single attempt) when the node-DB record persists despite delete", async () => {
    const iscsiadm = fakeIscsiadm({
      sessions: [session(IQN)],
      deleteThrows: true,
      deleteRemovesEntry: false,
    });
    const logger = spyLogger();
    await assert.rejects(
      logoutAndDeleteTarget(deps(iscsiadm, logger), IQN, PORTAL),
      isUnknown
    );
    // delete is attempted exactly once (the CO retries), no 30s loop
    assert.strictEqual(iscsiadm.calls.deleteNodeDBEntry.length, 1);
    assert.ok(iscsiadm.peekDB().has(`${IQN}|${PORTAL}`));
    assert.ok(
      logger.messages.warn.some((m) => m.includes("iscsiadm-delete-boom")),
      "expected the underlying delete error to be logged"
    );
  });
});

describe("reclaimDeadIscsiSession", () => {
  it("is idempotent success when no matching session exists (target gone)", async () => {
    const iscsiadm = fakeIscsiadm({ sessions: [] });
    const res = await reclaimDeadIscsiSession(
      deps(iscsiadm, spyLogger()),
      VOLUME_ID
    );
    assert.deepStrictEqual(res, { reclaimed: false, sessions: [] });
    assert.strictEqual(iscsiadm.calls.logout.length, 0);
    assert.strictEqual(iscsiadm.calls.deleteNodeDBEntry.length, 0);
  });

  it("logs out + deletes the node-DB entry for the matched target, verifying state", async () => {
    const iscsiadm = fakeIscsiadm({ sessions: [session(IQN)] });
    const res = await reclaimDeadIscsiSession(
      deps(iscsiadm, spyLogger()),
      VOLUME_ID
    );
    assert.strictEqual(res.reclaimed, true);
    assert.deepStrictEqual(iscsiadm.calls.logout[0], {
      target: IQN,
      portals: [PORTAL],
    });
    assert.deepStrictEqual(iscsiadm.calls.deleteNodeDBEntry[0], {
      target: IQN,
      portal: PORTAL,
    });
    assert.strictEqual(iscsiadm.peekSessions().length, 0);
    assert.strictEqual(iscsiadm.peekDB().size, 0);
  });

  it("returns a retryable error when the iSCSI session is still logged in after logout (does not report success)", async () => {
    // core honesty guarantee: reporting success here would let the CO
    // DeleteVolume under a live session and leak the target permanently. The
    // device-fallback path enforces the same via the shared logoutAndDeleteTarget
    const iscsiadm = fakeIscsiadm({
      sessions: [session(IQN)],
      logoutThrows: true,
      logoutRemovesSession: false,
    });
    await assert.rejects(
      reclaimDeadIscsiSession(deps(iscsiadm, spyLogger()), VOLUME_ID),
      isUnknown
    );
    assert.strictEqual(iscsiadm.peekSessions().length, 1);
  });

  it("reports FAILURE when a node-DB record lingers even though the session is gone", async () => {
    const iscsiadm = fakeIscsiadm({
      sessions: [session(IQN)],
      logoutRemovesSession: true,
      deleteThrows: true,
      deleteRemovesEntry: false,
    });
    await assert.rejects(
      reclaimDeadIscsiSession(deps(iscsiadm, spyLogger()), VOLUME_ID),
      isUnknown
    );
    assert.strictEqual(iscsiadm.peekSessions().length, 0);
    assert.ok(iscsiadm.peekDB().has(`${IQN}|${PORTAL}`));
  });

  it("surfaces a retryable error when sessions cannot be enumerated", async () => {
    const iscsiadm = fakeIscsiadm({ sessions: [] });
    iscsiadm.getSessionsDetails = async () => {
      throw new Error("iscsiadm exploded");
    };
    await assert.rejects(
      reclaimDeadIscsiSession(deps(iscsiadm, spyLogger()), VOLUME_ID),
      isUnknown
    );
  });
});

// error shapes as rejected by iscsi.exec (utils/iscsi.js)
// exit 127 from the docker/iscsiadm chroot wrapper: host has no open-iscsi
function exit127Error() {
  return {
    code: 127,
    stdout: "",
    stderr:
      "chroot: failed to run command 'iscsiadm': No such file or directory",
    timeout: false,
  };
}

// spawn failure: the wrapper binary itself is missing
function spawnEnoentError() {
  const err = new Error("spawn /usr/local/sbin/iscsiadm ENOENT");
  err.code = "ENOENT";
  return {
    code: null,
    stdout: "",
    stderr: String(err),
    timeout: false,
    error: err,
  };
}

describe("iscsiadmUnusable", () => {
  it("recognizes host-missing-iscsiadm signatures", () => {
    assert.strictEqual(iscsiadmUnusable(exit127Error()), true);
    assert.strictEqual(iscsiadmUnusable(spawnEnoentError()), true);
    assert.strictEqual(
      iscsiadmUnusable({ code: 1, stderr: "sh: iscsiadm: not found" }),
      true
    );
    assert.strictEqual(
      iscsiadmUnusable({
        code: 1,
        stderr: "failed to find iscsid pid for nsenter",
      }),
      true
    );
  });

  it("does NOT classify operational failures as unusable", () => {
    // timeout (lock convoy / stalled iscsid)
    assert.strictEqual(
      iscsiadmUnusable({ code: null, stderr: "", timeout: true }),
      false
    );
    // real iscsiadm error from a working binary
    assert.strictEqual(
      iscsiadmUnusable({
        code: 8,
        stderr: "iscsiadm: connection login retries (reopen_max) 5 exceeded",
      }),
      false
    );
    // exit 21 "No records found" must not read as "not found"
    assert.strictEqual(
      iscsiadmUnusable({ code: 21, stderr: "iscsiadm: No records found" }),
      false
    );
    assert.strictEqual(iscsiadmUnusable(new Error("iscsiadm exploded")), false);
  });
});

describe("reclaimDeadIscsiSession - gating for volumes with no iscsi evidence (issue #33)", () => {
  // regression: NFS/SMB/hostpath unstage on a host without open-iscsi must not
  // fail the RPC because the unconditional reclaim could not run iscsiadm
  for (const [label, makeError] of [
    ["chroot wrapper exit 127", exit127Error],
    ["spawn ENOENT", spawnEnoentError],
  ]) {
    it(`tolerates ${label} when iscsiExpected=false (nothing to reclaim, RPC continues)`, async () => {
      const iscsiadm = fakeIscsiadm({ sessions: [] });
      iscsiadm.getSessionsDetails = async () => {
        throw makeError();
      };
      const logger = spyLogger();
      const res = await reclaimDeadIscsiSession(
        deps(iscsiadm, logger),
        VOLUME_ID,
        { iscsiExpected: false }
      );
      assert.deepStrictEqual(res, { reclaimed: false, sessions: [] });
      assert.strictEqual(iscsiadm.calls.logout.length, 0);
      assert.strictEqual(iscsiadm.calls.deleteNodeDBEntry.length, 0);
      // tolerated, not silent
      assert.ok(
        logger.messages.warn.some((m) =>
          m.includes("assuming no iscsi sessions to reclaim")
        ),
        "expected a warning about the unusable iscsiadm"
      );
    });
  }

  it("still hard-fails on exit 127 when iscsi involvement is confirmed (iscsiExpected=true)", async () => {
    const iscsiadm = fakeIscsiadm({ sessions: [] });
    iscsiadm.getSessionsDetails = async () => {
      throw exit127Error();
    };
    await assert.rejects(
      reclaimDeadIscsiSession(deps(iscsiadm, spyLogger()), VOLUME_ID, {
        iscsiExpected: true,
      }),
      isUnknown
    );
  });

  it("still hard-fails on exit 127 by default (existing callers keep fail-fast)", async () => {
    const iscsiadm = fakeIscsiadm({ sessions: [] });
    iscsiadm.getSessionsDetails = async () => {
      throw exit127Error();
    };
    await assert.rejects(
      reclaimDeadIscsiSession(deps(iscsiadm, spyLogger()), VOLUME_ID),
      isUnknown
    );
  });

  it("still hard-fails when iscsiExpected=false but the failure is operational (timeout), not a missing binary", async () => {
    const iscsiadm = fakeIscsiadm({ sessions: [] });
    iscsiadm.getSessionsDetails = async () => {
      throw { code: null, stdout: "", stderr: "", timeout: true };
    };
    await assert.rejects(
      reclaimDeadIscsiSession(deps(iscsiadm, spyLogger()), VOLUME_ID, {
        iscsiExpected: false,
      }),
      isUnknown
    );
  });

  it("a matched session is itself iscsi evidence: re-enumeration failure hard-fails even with iscsiExpected=false", async () => {
    const iscsiadm = fakeIscsiadm({ sessions: [session(IQN)] });
    const realGetSessionsDetails =
      iscsiadm.getSessionsDetails.bind(iscsiadm);
    let enumerations = 0;
    iscsiadm.getSessionsDetails = async () => {
      enumerations++;
      if (enumerations > 1) {
        throw exit127Error();
      }
      return realGetSessionsDetails();
    };
    await assert.rejects(
      reclaimDeadIscsiSession(deps(iscsiadm, spyLogger()), VOLUME_ID, {
        iscsiExpected: false,
      }),
      isUnknown
    );
    // the logout still ran before the verification failure
    assert.strictEqual(iscsiadm.calls.logout.length, 1);
  });

  it("iscsiExpected=false does not change behavior when iscsiadm works and a session matches (still reclaims + verifies)", async () => {
    const iscsiadm = fakeIscsiadm({ sessions: [session(IQN)] });
    const res = await reclaimDeadIscsiSession(
      deps(iscsiadm, spyLogger()),
      VOLUME_ID,
      { iscsiExpected: false }
    );
    assert.strictEqual(res.reclaimed, true);
    assert.strictEqual(iscsiadm.peekSessions().length, 0);
    assert.strictEqual(iscsiadm.peekDB().size, 0);
  });
});

describe("disconnectNvmeByNQN", () => {
  it("succeeds when the subsystem is gone after disconnect", async () => {
    const nvmeof = fakeNvmeof({ subsystems: [NQN], disconnectRemoves: true });
    await assert.doesNotReject(disconnectNvmeByNQN({ nvmeof }, NQN));
    assert.deepStrictEqual(nvmeof.calls.disconnectByNQN, [NQN]);
    assert.ok(nvmeof.calls.getSubsystemByNQN.length >= 1);
  });

  it("throws a retryable error when the subsystem persists after disconnect", async () => {
    const nvmeof = fakeNvmeof({ subsystems: [NQN], disconnectRemoves: false });
    await assert.rejects(disconnectNvmeByNQN({ nvmeof }, NQN), isUnknown);
  });
});
