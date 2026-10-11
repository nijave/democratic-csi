const assert = require("node:assert");
const { describe, it } = require("node:test");

const { CsiBaseDriver } = require("../../src/driver/index");
const { grpc } = require("../../src/utils/grpc");

function isInvalidArgument(err) {
  return err && err.code === grpc.status.INVALID_ARGUMENT;
}

function makeDriver(options) {
  return new CsiBaseDriver({}, options || {});
}

describe("getMergedDriverOptions - zfs.datasetProperties overlay", () => {
  it("merges overlay properties into driver-level properties (overlay wins)", () => {
    const driver = makeDriver({
      zfs: {
        datasetProperties: {
          "homelab:tier": "fast",
          "homelab:owner": "me",
        },
      },
    });
    const merged = driver.getMergedDriverOptions([
      { zfs: { datasetProperties: { "homelab:owner": "you" } } },
    ]);

    assert.deepStrictEqual(merged.zfs.datasetProperties, {
      "homelab:tier": "fast",
      "homelab:owner": "you",
    });
  });

  it("creates datasetProperties when driver-level has none", () => {
    const driver = makeDriver({ zfs: { zvolBlocksize: "16K" } });
    const merged = driver.getMergedDriverOptions([
      { zfs: { datasetProperties: { "homelab:sanoid-skip": "true" } } },
    ]);

    assert.deepStrictEqual(merged.zfs.datasetProperties, {
      "homelab:sanoid-skip": "true",
    });
  });

  it("later overlays (PVC) override earlier ones (StorageClass)", () => {
    const driver = makeDriver();
    const merged = driver.getMergedDriverOptions([
      { zfs: { datasetProperties: { "homelab:tag": "from-storageclass" } } },
      { zfs: { datasetProperties: { "homelab:tag": "from-pvc" } } },
    ]);

    assert.strictEqual(merged.zfs.datasetProperties["homelab:tag"], "from-pvc");
  });

  it("merges across overlays instead of replacing them", () => {
    const driver = makeDriver();
    const merged = driver.getMergedDriverOptions([
      { zfs: { datasetProperties: { "homelab:a": "1" } } },
      { zfs: { datasetProperties: { "homelab:b": "2" } } },
    ]);

    assert.deepStrictEqual(merged.zfs.datasetProperties, {
      "homelab:a": "1",
      "homelab:b": "2",
    });
  });

  it("converts number and boolean overlay values to strings", () => {
    const driver = makeDriver();
    const merged = driver.getMergedDriverOptions([
      {
        zfs: {
          datasetProperties: { "homelab:count": 42, "homelab:enabled": true },
        },
      },
    ]);

    assert.deepStrictEqual(merged.zfs.datasetProperties, {
      "homelab:count": "42",
      "homelab:enabled": "true",
    });
  });

  it("rejects overlay property names without a colon (not user properties)", () => {
    const driver = makeDriver();
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          { zfs: { datasetProperties: { quota: "10G" } } },
        ]),
      isInvalidArgument
    );
  });

  it("rejects overlay property names starting with democratic-csi:", () => {
    const driver = makeDriver();
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          {
            zfs: {
              datasetProperties: { "democratic-csi:managed_resource": "false" },
            },
          },
        ]),
      isInvalidArgument
    );
  });

  it("rejects overlay property values that cannot become strings", () => {
    const driver = makeDriver();
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          { zfs: { datasetProperties: { "homelab:obj": { a: 1 } } } },
        ]),
      isInvalidArgument
    );
  });

  it("rejects a non-object datasetProperties overlay", () => {
    const driver = makeDriver();
    assert.throws(
      () => driver.getMergedDriverOptions([{ zfs: { datasetProperties: null } }]),
      isInvalidArgument
    );
  });

  it("keeps driver-level properties unrestricted (no colon required)", () => {
    const driver = makeDriver({
      zfs: { datasetProperties: { quota: "10G", "homelab:tag": "x" } },
    });
    const merged = driver.getMergedDriverOptions([
      { zfs: { datasetProperties: { "homelab:new": "y" } } },
    ]);

    assert.deepStrictEqual(merged.zfs.datasetProperties, {
      quota: "10G",
      "homelab:tag": "x",
      "homelab:new": "y",
    });
  });

  it("does not mutate driver.options (nested zfs object)", () => {
    const driver = makeDriver({
      zfs: {
        datasetProperties: { "homelab:tier": "fast" },
      },
    });
    const before = JSON.parse(JSON.stringify(driver.options));

    driver.getMergedDriverOptions([
      {
        zfs: {
          zvolBlocksize: "32K",
          datasetProperties: { "homelab:tier": "slow" },
        },
      },
    ]);

    assert.deepStrictEqual(driver.options, before);
  });

  it("does not mutate driver.options when driver-level datasetProperties is undefined", () => {
    const driver = makeDriver({ zfs: {} });
    driver.getMergedDriverOptions([
      { zfs: { datasetProperties: { "homelab:a": "1" } } },
    ]);

    assert.deepStrictEqual(driver.options.zfs, {});
  });
});

describe("getMergedDriverOptions - zfs.zvolBlocksize (unchanged)", () => {
  it("still overrides zvolBlocksize from an overlay", () => {
    const driver = makeDriver({ zfs: { zvolBlocksize: "16K" } });
    const merged = driver.getMergedDriverOptions([
      { zfs: { zvolBlocksize: "64K" } },
    ]);

    assert.strictEqual(merged.zfs.zvolBlocksize, "64K");
  });

  it("keeps driver-level zvolBlocksize when no overlay provides it", () => {
    const driver = makeDriver({ zfs: { zvolBlocksize: "16K" } });
    const merged = driver.getMergedDriverOptions([
      { zfs: { datasetProperties: { "homelab:a": "1" } } },
    ]);

    assert.strictEqual(merged.zfs.zvolBlocksize, "16K");
  });
});
