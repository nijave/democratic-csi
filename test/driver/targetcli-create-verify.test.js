const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  ControllerZfsGenericDriver,
} = require("../../src/driver/controller-zfs-generic/index");
const { GrpcError, grpc } = require("../../src/utils/grpc");

// After a zfs clone, the /dev/zvol/<dataset> symlink is created by udev
// asynchronously. createShare used to run targetcli immediately; targetcli
// printed "Could not open /dev/zvol/..." but still exited 0, so CreateVolume
// succeeded with an iSCSI target that had no LUN and the node could never
// attach it. createShare must wait for the device and verify the LUN exists.

const DATASET = "tank/k8s/pvs/pvc-abc123";
const BASENAME = "iqn.2025-04.test:host";
const DEVICE = "/dev/zvol/tank/k8s/pvs/pvc-abc123";

const proto = ControllerZfsGenericDriver.prototype;

const zb = {
  helpers: {
    extractLeafName: (name) => name.split("/").pop(),
    isPropertyValueSet: (v) => v !== undefined && v !== null && v !== "-",
  },
};

// fake storage host: `test -e DEVICE` succeeds once deviceAfter polls have
// happened; targetcli scripts are handed to onTargetCli for a response
function makeDriver({ deviceAfter = 0, onTargetCli, auth } = {}) {
  const state = { tests: 0, scripts: [], logs: [] };
  const execClient = {
    buildCommand: (name, args = []) => [name, ...args].join(" "),
    exec: async (cmd) => {
      if (cmd === "udevadm settle") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === `test -e ${DEVICE}`) {
        state.tests++;
        return { code: state.tests > deviceAfter ? 0 : 1 };
      }
      if (cmd.startsWith("sh -c ")) {
        const script = cmd.slice("sh -c ".length);
        state.scripts.push(script);
        return onTargetCli(script, state);
      }
      throw new Error(`unexpected command: ${cmd}`);
    },
  };
  const driver = Object.create(proto);
  driver.options = {
    driver: "zfs-generic-iscsi",
    iscsi: {
      shareStrategy: "targetCli",
      shareStrategyTargetCli: {
        basename: BASENAME,
        deviceWaitTimeout: 50,
        deviceWaitInterval: 1,
        tpg: auth ? { auth } : undefined,
      },
    },
  };
  driver.ctx = {
    logger: {
      debug() {},
      error() {},
      info() {},
      warn() {},
      verbose: (msg) => state.logs.push(msg),
    },
  };
  driver.getZetabyte = async () => zb;
  driver.getExecClient = () => execClient;
  return { driver, state };
}

// healthy targetcli: verification paths all resolve
function healthyTargetCli(script) {
  return { code: 0, stdout: script.includes(" pwd") ? "/> /ok\r\n" : "" };
}

async function createShare(driver) {
  const call = { request: { name: "pvc-abc123", parameters: {} } };
  // createShare goes on to set zfs properties after the share exists; only the
  // targetcli handling matters here, so stop at the first zfs access
  try {
    await proto.createShare.call(driver, call, DATASET);
  } catch (err) {
    if (err instanceof GrpcError) throw err;
  }
}

describe("generic-iscsi targetcli createShare waits for zvol and verifies LUN", () => {
  it("polls until the device appears before running targetcli", async () => {
    const { driver, state } = makeDriver({
      deviceAfter: 3,
      onTargetCli: healthyTargetCli,
    });
    await createShare(driver);
    assert.strictEqual(state.tests, 4);
    assert.ok(state.scripts.length >= 2);
    assert.match(state.scripts[0], /\/backstores\/block create pvc-abc123/);
    assert.match(
      state.scripts[1],
      /\/iscsi\/iqn\.2025-04\.test:host:pvc-abc123\/tpg1\/luns\/lun0 pwd/,
    );
  });

  it("fails UNAVAILABLE without running targetcli if the device never appears", async () => {
    const { driver, state } = makeDriver({
      deviceAfter: Infinity,
      onTargetCli: healthyTargetCli,
    });
    await assert.rejects(createShare(driver), (err) => {
      assert.ok(err instanceof GrpcError);
      assert.strictEqual(err.code, grpc.status.UNAVAILABLE);
      return true;
    });
    assert.strictEqual(state.scripts.length, 0);
  });

  it("fails UNAVAILABLE when targetcli exits 0 but the LUN is missing", async () => {
    const { driver, state } = makeDriver({
      onTargetCli: (script) => ({
        code: 0,
        stdout: script.includes(" pwd")
          ? "/> No such path /backstores/block/pvc-abc123\r\n"
          : `Could not open ${DEVICE}\r\n`,
      }),
    });
    // retry delays are real (2s, 2s); keep this test to the default retries
    await assert.rejects(createShare(driver), (err) => {
      assert.ok(err instanceof GrpcError);
      assert.strictEqual(err.code, grpc.status.UNAVAILABLE);
      return true;
    });
    // 3 attempts of create + verify
    assert.strictEqual(state.scripts.length, 6);
  });

  it("recovers when a retry finds the LUN created", async () => {
    let verifies = 0;
    const { driver, state } = makeDriver({
      onTargetCli: (script) => {
        if (!script.includes(" pwd")) return { code: 0, stdout: "" };
        verifies++;
        return {
          code: 0,
          stdout: verifies === 1 ? "/> No such path /x\r\n" : "/> /ok\r\n",
        };
      },
    });
    await createShare(driver);
    assert.strictEqual(state.scripts.length, 4);
  });

  it("redacts CHAP passwords in logged command and response", async () => {
    const { driver, state } = makeDriver({
      auth: { userid: "k8s", password: "s3cret", mutual_password: "m00tual" },
      onTargetCli: (script) => ({
        code: 0,
        // the pty echoes the script back
        stdout: `${script}\r\nParameter password is now 's3cret'.\r\nParameter mutual_password is now 'm00tual'.\r\n/> /ok\r\n`,
      }),
    });
    await createShare(driver);
    assert.ok(state.scripts[0].includes("password=s3cret"));
    const logs = state.logs.join("\n");
    assert.ok(logs.includes("TargetCLI command:"));
    assert.ok(logs.includes("TargetCLI response:"));
    assert.ok(!logs.includes("s3cret"), logs);
    assert.ok(!logs.includes("m00tual"), logs);
    assert.ok(logs.includes("password=<redacted>"));
  });
});
