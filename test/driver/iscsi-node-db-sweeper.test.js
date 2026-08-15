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
  function makeFakeIsci({ records, sessions, failIqns = [] } = {}) {
    const deletes = [];
    return {
      deletes,
      iscsiadm: {
        async listNodeDBEntries() {
          return records;
        },
        async getSessions() {
          return sessions;
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
});
