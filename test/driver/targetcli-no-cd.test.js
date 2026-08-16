const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  ControllerZfsGenericDriver,
} = require("../../src/driver/controller-zfs-generic/index");

// The generic-iscsi share strategy pipes a script into `targetcli`. A `cd`
// makes targetcli record navigation into configshell's prefs file; under
// concurrent ops (e.g. VolSync clone bursts) that non-atomic prefs write
// corrupts prefs.bin and crashes CreateVolume with "Ran out of input"
// (configshell-fb#60). Path-prefixed commands ("/path command") resolve via
// get_node() instead and never touch path_history, so the scripts must not
// use `cd`. This guards against a regression that reintroduces it.

const DATASET = "tank/k8s/pvs/pvc-abc123";
const BASENAME = "iqn.2025-04.test:host";

// create derives assetName from the dataset leaf; delete reads the
// iscsi_assets_name property -- return "-" (unset) so it also falls back to
// the leaf name.
const zb = {
  helpers: {
    extractLeafName: (name) => name.split("/").pop(),
    isPropertyValueSet: (v) => v !== undefined && v !== null && v !== "-",
  },
  zfs: {
    get: async (dataset) => ({
      [dataset]: new Proxy({}, { get: () => ({ value: "-" }) }),
    }),
  },
};

function driverWithCapture(captured) {
  return {
    options: {
      driver: "zfs-generic-iscsi",
      iscsi: {
        shareStrategy: "targetCli",
        shareStrategyTargetCli: { basename: BASENAME },
      },
    },
    ctx: {
      logger: { debug() {}, verbose() {}, error() {}, info() {}, warn() {} },
    },
    getZetabyte: async () => zb,
    getExecClient: () => ({}),
    // capture the script and report success; anything the method does after the
    // share is created is irrelevant to what we assert, so callers ignore it.
    targetCliCommand: async (script) => {
      captured.push(script);
      return { code: 0, stdout: "" };
    },
  };
}

async function captureScript(method) {
  const captured = [];
  const driver = driverWithCapture(captured);
  const call = { request: { name: "pvc-abc123", parameters: {} } };
  try {
    await ControllerZfsGenericDriver.prototype[method].call(
      driver,
      call,
      DATASET
    );
  } catch {
    // ignore errors raised after the targetcli script was captured
  }
  assert.strictEqual(
    captured.length,
    1,
    `${method} should issue exactly one targetcli script`
  );
  return captured[0];
}

function assertNoCd(script) {
  for (const line of script.split("\n")) {
    assert.ok(!/^\s*cd(\s|$)/.test(line), `unexpected cd command: '${line}'`);
  }
}

describe("generic-iscsi targetcli scripts avoid cd (configshell-fb#60)", () => {
  it("createShare uses path-prefixed commands, no cd", async () => {
    const script = await captureScript("createShare");
    assertNoCd(script);
    assert.match(script, /^\/iscsi create iqn\.2025-04\.test:host:pvc-abc123$/m);
    assert.match(
      script,
      /^\/backstores\/block create pvc-abc123 \/dev\/zvol\/tank\/k8s\/pvs\/pvc-abc123$/m
    );
    assert.match(
      script,
      /^\/iscsi\/iqn\.2025-04\.test:host:pvc-abc123\/tpg1\/luns create \/backstores\/block\/pvc-abc123$/m
    );
  });

  it("deleteShare uses path-prefixed commands, no cd", async () => {
    const script = await captureScript("deleteShare");
    assertNoCd(script);
    assert.match(script, /^\/iscsi delete iqn\.2025-04\.test:host:pvc-abc123$/m);
    assert.match(script, /^\/backstores\/block delete pvc-abc123$/m);
  });
});
