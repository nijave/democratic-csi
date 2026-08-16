const assert = require("node:assert");
const { describe, it } = require("node:test");
const {
  ISCSINodeDbSweeper,
  selectOrphanedRecords,
} = require("../../src/utils/iscsi-node-db-sweeper");

// A record is deleted only when its target IQN has no active session (any
// portal) and, when configured, matches the driver basename. Pure predicate
// tests plus a runtime sweep test against a fake iscsi object.

const IQN_A = "iqn.2025-04.info.example:ubthv01:pvc-aaa";
const IQN_B = "iqn.2025-04.info.example:ubthv01:pvc-bbb";
const IQN_FOREIGN = "iqn.1991-05.com.microsoft:host-foreign";
const BASENAME = "iqn.2025-04.info.example:ubthv01:";

describe("selectOrphanedRecords", () => {
  it("selects records whose target has no session", () => {
    const records = [
      { portal: "172.16.1.118:3260,1", iqn: IQN_A },
      { portal: "172.16.1.118:3260,1", iqn: IQN_B },
    ];
    const sessions = [{ iqn: IQN_B }];

    assert.deepStrictEqual(selectOrphanedRecords(records, sessions), [
      { portal: "172.16.1.118:3260,1", iqn: IQN_A },
    ]);
  });

  it("keeps every record of a target that has a session on any portal", () => {
    const records = [
      { portal: "172.16.1.118:3260,1", iqn: IQN_A },
      { portal: "172.16.1.119:3260,1", iqn: IQN_A },
    ];
    const sessions = [{ iqn: IQN_A }];

    assert.deepStrictEqual(selectOrphanedRecords(records, sessions), []);
  });

  it("skips foreign targets when targetBasename is set", () => {
    const records = [
      { portal: "172.16.1.118:3260,1", iqn: IQN_FOREIGN },
      { portal: "172.16.1.118:3260,1", iqn: IQN_A },
    ];
    const sessions = [];

    assert.deepStrictEqual(
      selectOrphanedRecords(records, sessions, BASENAME),
      [{ portal: "172.16.1.118:3260,1", iqn: IQN_A }]
    );
  });

  it("sweeps all targets when targetBasename is unset", () => {
    const records = [
      { portal: "172.16.1.118:3260,1", iqn: IQN_FOREIGN },
      { portal: "172.16.1.118:3260,1", iqn: IQN_A },
    ];

    assert.deepStrictEqual(
      selectOrphanedRecords(records, [], null).length,
      2
    );
  });

  it("ignores records without an iqn", () => {
    assert.deepStrictEqual(
      selectOrphanedRecords([{ portal: "172.16.1.118:3260,1", iqn: "" }], []),
      []
    );
  });
});

describe("ISCSINodeDbSweeper.sweep", () => {
  // lateSessionIqns simulates a login racing the sweep: those IQNs appear
  // only on getSessions() calls AFTER the first (snapshot) call, i.e. at
  // per-record re-check time. missingIqns simulates a record deleted by
  // someone else between the snapshot and the re-check.
  function makeFakeIsci({
    records,
    sessions,
    failIqns = [],
    missingIqns = [],
    lateSessionIqns = [],
  } = {}) {
    const deletes = [];
    let getSessionsCalls = 0;
    return {
      deletes,
      iscsiadm: {
        async listNodeDBEntries() {
          return records;
        },
        async getSessions() {
          getSessionsCalls++;
          if (getSessionsCalls === 1) {
            return sessions;
          }
          return sessions.concat(lateSessionIqns.map((iqn) => ({ iqn })));
        },
        async nodeDBEntryExists(iqn, portal) {
          return !missingIqns.includes(iqn);
        },
        async deleteNodeDBEntry(iqn, portal) {
          if (failIqns.includes(iqn)) {
            throw { code: 1, stderr: "iscsiadm: database failure" };
          }
          deletes.push({ iqn, portal });
        },
      },
    };
  }

  function makeLogger() {
    const entries = { info: [], error: [] };
    return {
      entries,
      info: (...args) => entries.info.push(args.join(" ")),
      error: (...args) => entries.error.push(args.join(" ")),
    };
  }

  it("deletes only orphans and logs the sweep", async () => {
    const iscsi = makeFakeIsci({
      records: [
        { portal: "172.16.1.118:3260,1", iqn: IQN_A },
        { portal: "172.16.1.118:3260,1", iqn: IQN_B },
      ],
      sessions: [{ iqn: IQN_B }],
    });
    const logger = makeLogger();
    const sweeper = new ISCSINodeDbSweeper({ iscsi, logger });

    await sweeper.sweep();

    assert.deepStrictEqual(iscsi.deletes, [
      { iqn: IQN_A, portal: "172.16.1.118:3260,1" },
    ]);
    assert.ok(
      logger.entries.info.some((line) => line.includes("orphaned"))
    );
  });

  it("a per-record failure is logged and does not abort the sweep", async () => {
    const iscsi = makeFakeIsci({
      records: [
        { portal: "172.16.1.118:3260,1", iqn: IQN_A },
        { portal: "172.16.1.118:3260,1", iqn: IQN_B },
      ],
      sessions: [],
      failIqns: [IQN_A],
    });
    const logger = makeLogger();
    const sweeper = new ISCSINodeDbSweeper({ iscsi, logger });

    await sweeper.sweep();

    assert.deepStrictEqual(iscsi.deletes, [
      { iqn: IQN_B, portal: "172.16.1.118:3260,1" },
    ]);
    assert.ok(
      logger.entries.error.some((line) => line.includes(IQN_A))
    );
  });

  it("does nothing when every record is in use", async () => {
    const iscsi = makeFakeIsci({
      records: [{ portal: "172.16.1.118:3260,1", iqn: IQN_A }],
      sessions: [{ iqn: IQN_A }],
    });
    const logger = makeLogger();
    const sweeper = new ISCSINodeDbSweeper({ iscsi, logger });

    await sweeper.sweep();

    assert.deepStrictEqual(iscsi.deletes, []);
    assert.ok(logger.entries.info.some((line) => line.includes("all in use")));
  });

  // Regression: NodeStageVolume creates the node-DB record before logging
  // in, so a record with no session in the initial snapshot may belong to a
  // stage in flight. The per-record re-check must catch the session that
  // appeared after the snapshot and skip the delete.
  it("skips a record whose session appears between snapshot and re-check", async () => {
    const iscsi = makeFakeIsci({
      records: [
        { portal: "172.16.1.118:3260,1", iqn: IQN_A },
        { portal: "172.16.1.118:3260,1", iqn: IQN_B },
      ],
      sessions: [],
      lateSessionIqns: [IQN_A],
    });
    const logger = makeLogger();
    const sweeper = new ISCSINodeDbSweeper({ iscsi, logger });

    await sweeper.sweep();

    // IQN_A raced a login and must survive; IQN_B is a real orphan
    assert.deepStrictEqual(iscsi.deletes, [
      { iqn: IQN_B, portal: "172.16.1.118:3260,1" },
    ]);
    assert.ok(
      logger.entries.info.some(
        (line) =>
          line.includes(IQN_A) && line.includes("session appeared")
      )
    );
  });

  // Regression: a record removed by someone else after the snapshot (e.g. a
  // concurrent NodeUnstageVolume) must be skipped cleanly rather than fed to
  // -o delete, which errors on an already-absent record.
  it("skips a record that disappears between snapshot and re-check", async () => {
    const iscsi = makeFakeIsci({
      records: [
        { portal: "172.16.1.118:3260,1", iqn: IQN_A },
        { portal: "172.16.1.118:3260,1", iqn: IQN_B },
      ],
      sessions: [],
      missingIqns: [IQN_A],
    });
    const logger = makeLogger();
    const sweeper = new ISCSINodeDbSweeper({ iscsi, logger });

    await sweeper.sweep();

    assert.deepStrictEqual(iscsi.deletes, [
      { iqn: IQN_B, portal: "172.16.1.118:3260,1" },
    ]);
    assert.ok(
      logger.entries.info.some(
        (line) =>
          line.includes(IQN_A) && line.includes("no longer exists")
      )
    );
    assert.deepStrictEqual(logger.entries.error, []);
  });

  it("a re-check failure is logged and does not abort the sweep", async () => {
    const iscsi = makeFakeIsci({
      records: [
        { portal: "172.16.1.118:3260,1", iqn: IQN_A },
        { portal: "172.16.1.118:3260,1", iqn: IQN_B },
      ],
      sessions: [],
    });
    iscsi.iscsiadm.nodeDBEntryExists = async (iqn) => {
      if (iqn === IQN_A) {
        throw { code: 1, stderr: "iscsiadm: database failure" };
      }
      return true;
    };
    const logger = makeLogger();
    const sweeper = new ISCSINodeDbSweeper({ iscsi, logger });

    await sweeper.sweep();

    assert.deepStrictEqual(iscsi.deletes, [
      { iqn: IQN_B, portal: "172.16.1.118:3260,1" },
    ]);
    assert.ok(logger.entries.error.some((line) => line.includes(IQN_A)));
  });
});
