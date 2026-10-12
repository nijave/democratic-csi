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

describe("getMergedDriverOptions - zfs.datasetProperties overlay provenance", () => {
  // cloneDatasetProperties copies must slot *between* driver-level
  // datasetProperties and overlay datasetProperties, so overlay entries are
  // tracked separately from driver-level entries
  it("keeps overlay entries separate from driver-level datasetProperties", () => {
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
      "homelab:owner": "me",
    });
    assert.deepStrictEqual(merged.zfs.datasetPropertiesOverlay, {
      "homelab:owner": "you",
    });
  });

  it("collects overlay entries across overlays (later overlays win)", () => {
    const driver = makeDriver();
    const merged = driver.getMergedDriverOptions([
      { zfs: { datasetProperties: { "homelab:a": "1", "homelab:tag": "sc" } } },
      { zfs: { datasetProperties: { "homelab:b": "2", "homelab:tag": "pvc" } } },
    ]);

    assert.deepStrictEqual(merged.zfs.datasetPropertiesOverlay, {
      "homelab:a": "1",
      "homelab:tag": "pvc",
      "homelab:b": "2",
    });
  });

  it("leaves merged.zfs.datasetProperties untouched when no overlay", () => {
    const driver = makeDriver({
      zfs: { datasetProperties: { "homelab:tier": "fast" } },
    });
    const merged = driver.getMergedDriverOptions([]);

    assert.deepStrictEqual(merged.zfs.datasetProperties, {
      "homelab:tier": "fast",
    });
    assert.strictEqual(merged.zfs.datasetPropertiesOverlay, undefined);
  });
});

describe("getMergedDriverOptions - zfs.cloneDatasetProperties", () => {
  it("normalizes driver-level config (fills defaults)", () => {
    const driver = makeDriver({
      zfs: {
        cloneDatasetProperties: {
          copy: ["syncoid:sync"],
          set: { "homelab:sanoid-skip": "true" },
        },
      },
    });
    const merged = driver.getMergedDriverOptions([]);

    assert.deepStrictEqual(merged.zfs.cloneDatasetProperties, {
      copy: ["syncoid:sync"],
      set: { "homelab:sanoid-skip": "true" },
    });
  });

  it("accepts the '*' copy pattern and prefix patterns", () => {
    const driver = makeDriver({
      zfs: { cloneDatasetProperties: { copy: ["*", "homelab:*"] } },
    });
    const merged = driver.getMergedDriverOptions([]);

    assert.deepStrictEqual(merged.zfs.cloneDatasetProperties.copy, [
      "*",
      "homelab:*",
    ]);
  });

  it("unions copy lists across driver config, StorageClass, and PVC (dedup)", () => {
    const driver = makeDriver({
      zfs: { cloneDatasetProperties: { copy: ["syncoid:sync", "homelab:*"] } },
    });
    const merged = driver.getMergedDriverOptions([
      { zfs: { cloneDatasetProperties: { copy: ["other:*"] } } },
      { zfs: { cloneDatasetProperties: { copy: ["homelab:*", "syncoid:sync"] } } },
    ]);

    assert.deepStrictEqual(merged.zfs.cloneDatasetProperties.copy, [
      "syncoid:sync",
      "homelab:*",
      "other:*",
    ]);
  });

  it("merges set maps with later overlays overriding (driver < sc < pvc)", () => {
    const driver = makeDriver({
      zfs: {
        cloneDatasetProperties: {
          set: { "homelab:a": "driver", "homelab:b": "driver" },
        },
      },
    });
    const merged = driver.getMergedDriverOptions([
      { zfs: { cloneDatasetProperties: { set: { "homelab:b": "sc" } } } },
      {
        zfs: {
          cloneDatasetProperties: { set: { "homelab:a": "pvc", "homelab:c": "pvc" } },
        },
      },
    ]);

    assert.deepStrictEqual(merged.zfs.cloneDatasetProperties.set, {
      "homelab:a": "pvc",
      "homelab:b": "sc",
      "homelab:c": "pvc",
    });
  });

  it("converts number and boolean set values to strings", () => {
    const driver = makeDriver();
    const merged = driver.getMergedDriverOptions([
      {
        zfs: {
          cloneDatasetProperties: {
            set: { "homelab:count": 42, "homelab:enabled": true },
          },
        },
      },
    ]);

    assert.deepStrictEqual(merged.zfs.cloneDatasetProperties.set, {
      "homelab:count": "42",
      "homelab:enabled": "true",
    });
  });

  it("rejects a non-object cloneDatasetProperties overlay", () => {
    const driver = makeDriver();
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          { zfs: { cloneDatasetProperties: null } },
        ]),
      isInvalidArgument
    );
  });

  it("rejects unknown keys in cloneDatasetProperties", () => {
    const driver = makeDriver();
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          { zfs: { cloneDatasetProperties: { coppy: ["syncoid:sync"] } } },
        ]),
      isInvalidArgument
    );
  });

  it("rejects driver-level copy entries that are not user properties", () => {
    const driver = makeDriver({
      zfs: { cloneDatasetProperties: { copy: ["quota"] } },
    });
    assert.throws(() => driver.getMergedDriverOptions([]), isInvalidArgument);
  });

  it("rejects copy entries that are not strings or arrays", () => {
    const driver = makeDriver();
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          { zfs: { cloneDatasetProperties: { copy: "syncoid:sync" } } },
        ]),
      isInvalidArgument
    );
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          { zfs: { cloneDatasetProperties: { copy: [42] } } },
        ]),
      isInvalidArgument
    );
  });

  it("rejects non-object set maps", () => {
    const driver = makeDriver();
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          { zfs: { cloneDatasetProperties: { set: ["syncoid:sync"] } } },
        ]),
      isInvalidArgument
    );
  });

  it("rejects democratic-csi:* in copy entries (exact and prefix)", () => {
    const driver = makeDriver();
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          {
            zfs: {
              cloneDatasetProperties: {
                copy: ["democratic-csi:managed_resource"],
              },
            },
          },
        ]),
      isInvalidArgument
    );
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          { zfs: { cloneDatasetProperties: { copy: ["democratic-csi:*"] } } },
        ]),
      isInvalidArgument
    );
  });

  it("rejects democratic-csi:* in set entries", () => {
    const driver = makeDriver();
    assert.throws(
      () =>
        driver.getMergedDriverOptions([
          {
            zfs: {
              cloneDatasetProperties: {
                set: { "democratic-csi:managed_resource": "false" },
              },
            },
          },
        ]),
      isInvalidArgument
    );
  });

  it("does not mutate driver.options (cloneDatasetProperties)", () => {
    const driver = makeDriver({
      zfs: {
        cloneDatasetProperties: { copy: ["syncoid:sync"], set: {} },
      },
    });
    const before = JSON.parse(JSON.stringify(driver.options));

    driver.getMergedDriverOptions([
      { zfs: { cloneDatasetProperties: { copy: ["other:x"] } } },
    ]);

    assert.deepStrictEqual(driver.options, before);
  });
});