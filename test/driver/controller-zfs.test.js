const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  ControllerZfsBaseDriver,
  datasetHasManagedSnapshots,
  buildCloneDatasetProperties,
  selectCopiedDatasetProperties,
} = require("../../src/driver/controller-zfs/index");

const MANAGED_PROPERTY_NAME = "democratic-csi:managed_resource";
const DATASET = "tank/k8s/pvs/pvc-8c49880-7201-497c-9cc2-88ebf967daac";

/**
 * Minimal zetabyte stub covering the two calls datasetHasManagedSnapshots
 * makes: zfs.list (legacy path) and zfs.get (source-filtered path).
 *
 * - listSnapshots: rows as returned in `indexed` by zb.zfs.list
 * - getProperties: object as returned by zb.zfs.get / parsePropertyList,
 *   i.e. only entries whose property source matched the requested sources
 */
function fakeZb({ listSnapshots = [], getProperties = {} } = {}) {
  const calls = { list: [], get: [] };
  return {
    calls,
    zfs: {
      list: async function (datasetName, properties, options) {
        calls.list.push({ datasetName, properties, options });
        return {
          properties,
          data: [],
          indexed: listSnapshots,
        };
      },
      get: async function (datasetName, properties, options) {
        calls.get.push({ datasetName, properties, options });
        return getProperties;
      },
    },
  };
}

describe("datasetHasManagedSnapshots - default (legacy) behavior", () => {
  it("blocks when a snapshot reports the managed property as true", async () => {
    // inherited values are indistinguishable from local ones in `zfs list`
    // output, so by default even foreign (sanoid/zfs-auto-snapshot)
    // snapshots block deletion
    const zb = fakeZb({
      listSnapshots: [
        {
          name: `${DATASET}@autosnap_2026-07-05_00:00:16_daily`,
          [MANAGED_PROPERTY_NAME]: "true",
        },
      ],
    });

    assert.strictEqual(await datasetHasManagedSnapshots(zb, DATASET), true);
    assert.strictEqual(zb.calls.list.length, 1);
    assert.strictEqual(zb.calls.get.length, 0);
    assert.deepStrictEqual(zb.calls.list[0].options, { types: ["snapshot"] });
  });

  it("is case-insensitive on the property value", async () => {
    const zb = fakeZb({
      listSnapshots: [
        { name: `${DATASET}@snap`, [MANAGED_PROPERTY_NAME]: "TRUE" },
      ],
    });

    assert.strictEqual(await datasetHasManagedSnapshots(zb, DATASET), true);
  });

  it("does not block when no snapshot is managed", async () => {
    const zb = fakeZb({
      listSnapshots: [
        { name: `${DATASET}@snap`, [MANAGED_PROPERTY_NAME]: "-" },
      ],
    });

    assert.strictEqual(await datasetHasManagedSnapshots(zb, DATASET), false);
  });

  it("does not block when there are no snapshots", async () => {
    const zb = fakeZb();

    assert.strictEqual(await datasetHasManagedSnapshots(zb, DATASET), false);
  });

  it("propagates errors (caller decides how to handle)", async () => {
    const zb = fakeZb();
    zb.zfs.list = async () => {
      throw new Error("cannot open 'tank/...': dataset does not exist");
    };

    await assert.rejects(
      datasetHasManagedSnapshots(zb, DATASET),
      /dataset does not exist/
    );
  });
});

describe("datasetHasManagedSnapshots - ignoreForeignSnapshots", () => {
  const opts = { ignoreForeignSnapshots: true };

  it("requests only locally set / received property sources", async () => {
    const zb = fakeZb();

    await datasetHasManagedSnapshots(zb, DATASET, opts);

    assert.strictEqual(zb.calls.list.length, 0);
    assert.strictEqual(zb.calls.get.length, 1);
    assert.deepStrictEqual(zb.calls.get[0].properties, [
      MANAGED_PROPERTY_NAME,
    ]);
    assert.deepStrictEqual(zb.calls.get[0].options, {
      types: ["snapshot"],
      recurse: true,
      sources: ["local", "received"],
    });
  });

  it("does not block when snapshots only inherit the property", async () => {
    // `zfs get -s local,received` omits inherited-only entries entirely,
    // so a dataset with nothing but sanoid autosnaps yields no entries
    const zb = fakeZb({ getProperties: {} });

    assert.strictEqual(
      await datasetHasManagedSnapshots(zb, DATASET, opts),
      false
    );
  });

  it("blocks when a snapshot has the property set directly", async () => {
    const zb = fakeZb({
      getProperties: {
        [`${DATASET}@snapshot-mysnap`]: {
          [MANAGED_PROPERTY_NAME]: {
            value: "true",
            received: "-",
            source: "local",
          },
        },
      },
    });

    assert.strictEqual(
      await datasetHasManagedSnapshots(zb, DATASET, opts),
      true
    );
  });

  it("ignores locally set property values other than true", async () => {
    const zb = fakeZb({
      getProperties: {
        [`${DATASET}@snap`]: {
          [MANAGED_PROPERTY_NAME]: {
            value: "false",
            received: "-",
            source: "local",
          },
        },
      },
    });

    assert.strictEqual(
      await datasetHasManagedSnapshots(zb, DATASET, opts),
      false
    );
  });

  it("ignores snapshots of other datasets returned by recursion", async () => {
    // recursion is required for `zfs get -t snapshot` to descend to the
    // dataset's snapshots at all; guard against entries from children
    const zb = fakeZb({
      getProperties: {
        [`${DATASET}-other@snapshot-mysnap`]: {
          [MANAGED_PROPERTY_NAME]: {
            value: "true",
            received: "-",
            source: "local",
          },
        },
      },
    });

    assert.strictEqual(
      await datasetHasManagedSnapshots(zb, DATASET, opts),
      false
    );
  });

  it("propagates errors (caller decides how to handle)", async () => {
    const zb = fakeZb();
    zb.zfs.get = async () => {
      throw new Error("cannot open 'tank/...': dataset does not exist");
    };

    await assert.rejects(
      datasetHasManagedSnapshots(zb, DATASET, opts),
      /dataset does not exist/
    );
  });
});

const FULL_SNAPSHOT_NAME = "tank/k8s/pvs/pvc-src@snap";

function snapshotEntry(value, source) {
  return { value, received: "-", source };
}

describe("selectCopiedDatasetProperties", () => {
  const inheritedFromSourceDataset = `inherited from tank/k8s/pvs/pvc-src`;

  it("copies an exact property inherited from the source dataset", () => {
    const copied = selectCopiedDatasetProperties(
      {
        "syncoid:sync": snapshotEntry("false", inheritedFromSourceDataset),
      },
      ["syncoid:sync"],
      FULL_SNAPSHOT_NAME
    );

    assert.deepStrictEqual(copied, { "syncoid:sync": "false" });
  });

  it("copies properties matching a prefix pattern", () => {
    const copied = selectCopiedDatasetProperties(
      {
        "homelab:sanoid-skip": snapshotEntry("true", "local"),
        "other:prop": snapshotEntry("yes", "local"),
      },
      ["homelab:*"],
      FULL_SNAPSHOT_NAME
    );

    assert.deepStrictEqual(copied, { "homelab:sanoid-skip": "true" });
  });

  it("copies every user property for the '*' pattern", () => {
    const copied = selectCopiedDatasetProperties(
      {
        "syncoid:sync": snapshotEntry("false", "received"),
        "homelab:tier": snapshotEntry("fast", "local"),
        volblocksize: snapshotEntry("16K", "default"),
      },
      ["*"],
      FULL_SNAPSHOT_NAME
    );

    assert.deepStrictEqual(copied, {
      "syncoid:sync": "false",
      "homelab:tier": "fast",
    });
  });

  it("never copies democratic-csi:* properties, even via '*'", () => {
    const copied = selectCopiedDatasetProperties(
      {
        "democratic-csi:managed_resource": snapshotEntry("true", "local"),
        "democratic-csi:csi_volume_name": snapshotEntry("pvc-src", "local"),
      },
      ["*"],
      FULL_SNAPSHOT_NAME
    );

    assert.deepStrictEqual(copied, {});
  });

  it("skips values inherited from ancestors above the source dataset", () => {
    const copied = selectCopiedDatasetProperties(
      {
        "syncoid:sync": snapshotEntry("false", "inherited from tank/k8s"),
      },
      ["syncoid:sync"],
      FULL_SNAPSHOT_NAME
    );

    assert.deepStrictEqual(copied, {});
  });

  it("skips default ('-') values", () => {
    const copied = selectCopiedDatasetProperties(
      {
        "syncoid:sync": snapshotEntry("-", inheritedFromSourceDataset),
        "homelab:tier": snapshotEntry("fast", "default"),
      },
      ["syncoid:sync", "homelab:tier"],
      FULL_SNAPSHOT_NAME
    );

    assert.deepStrictEqual(copied, {});
  });

  it("copies local and received property sources", () => {
    const copied = selectCopiedDatasetProperties(
      {
        "homelab:tier": snapshotEntry("fast", "local"),
        "syncoid:sync": snapshotEntry("false", "received"),
      },
      ["*"],
      FULL_SNAPSHOT_NAME
    );

    assert.deepStrictEqual(copied, {
      "homelab:tier": "fast",
      "syncoid:sync": "false",
    });
  });

  it("returns nothing without patterns", () => {
    const copied = selectCopiedDatasetProperties(
      { "syncoid:sync": snapshotEntry("false", "local") },
      [],
      FULL_SNAPSHOT_NAME
    );

    assert.deepStrictEqual(copied, {});
  });

  it("handles missing snapshot entries", () => {
    const copied = selectCopiedDatasetProperties(
      undefined,
      ["syncoid:sync"],
      FULL_SNAPSHOT_NAME
    );

    assert.deepStrictEqual(copied, {});
  });
});

describe("buildCloneDatasetProperties", () => {
  function makeZb(snapshotProperties) {
    const calls = { get: [] };
    const zb = {
      calls,
      zfs: {
        get: async function (dataset, properties, options) {
          calls.get.push({ dataset, properties, options });
          return { [dataset]: snapshotProperties };
        },
      },
    };
    return zb;
  }

  it("does not call zfs get when copy is absent", async () => {
    const zb = makeZb({});
    const props = await buildCloneDatasetProperties(zb, FULL_SNAPSHOT_NAME, {
      set: { "homelab:sanoid-skip": "true" },
    });

    assert.deepStrictEqual(props, { "homelab:sanoid-skip": "true" });
    assert.strictEqual(zb.calls.get.length, 0);
  });

  it("does not call zfs get when cloneDatasetProperties is unset", async () => {
    const zb = makeZb({});
    const props = await buildCloneDatasetProperties(
      zb,
      FULL_SNAPSHOT_NAME,
      undefined
    );

    assert.deepStrictEqual(props, {});
    assert.strictEqual(zb.calls.get.length, 0);
  });

  it("requests all properties from the source snapshot for copy", async () => {
    const zb = makeZb({
      "syncoid:sync": snapshotEntry("false", `inherited from tank/k8s/pvs/pvc-src`),
    });
    const props = await buildCloneDatasetProperties(
      zb,
      FULL_SNAPSHOT_NAME,
      { copy: ["syncoid:sync"] }
    );

    assert.deepStrictEqual(props, { "syncoid:sync": "false" });
    assert.strictEqual(zb.calls.get.length, 1);
    assert.deepStrictEqual(zb.calls.get[0], {
      dataset: FULL_SNAPSHOT_NAME,
      properties: ["all"],
      options: undefined,
    });
  });

  it("copies values literally (no templating)", async () => {
    const zb = makeZb({
      "homelab:note": snapshotEntry("{{ parameters.secret }}", "local"),
    });
    const props = await buildCloneDatasetProperties(
      zb,
      FULL_SNAPSHOT_NAME,
      { copy: ["homelab:note"] },
      { parameters: { secret: "hunter2" } }
    );

    assert.deepStrictEqual(props, {
      "homelab:note": "{{ parameters.secret }}",
    });
  });

  it("renders set values with handlebars", async () => {
    const zb = makeZb({});
    const props = await buildCloneDatasetProperties(
      zb,
      FULL_SNAPSHOT_NAME,
      { set: { "homelab:note": "pvc={{ parameters.pvc }}" } },
      { parameters: { pvc: "my-pvc" } }
    );

    assert.deepStrictEqual(props, { "homelab:note": "pvc=my-pvc" });
  });

  it("set values override copied values on name collision", async () => {
    const zb = makeZb({
      "syncoid:sync": snapshotEntry("true", "local"),
    });
    const props = await buildCloneDatasetProperties(
      zb,
      FULL_SNAPSHOT_NAME,
      { copy: ["syncoid:sync"], set: { "syncoid:sync": "false" } }
    );

    assert.deepStrictEqual(props, { "syncoid:sync": "false" });
  });
});

/**
 * CreateVolume integration (clone path): uses a snapshot content source whose
 * id already contains '@' so no snapshot needs to be created, and stubs the
 * zetabyte layer to record zfs commands.
 */
describe("CreateVolume - content source dataset properties", () => {
  const DATASET_NAME = "tank/k8s/pvs/pvc-test";
  const FULL_SNAPSHOT_NAME = "tank/k8s/pvs/pvc-src@snap";

  function makeFakeZb(snapshotProperties = {}) {
    const calls = {
      get: [],
      set: [],
      clone: [],
      create: [],
      snapshot: [],
      destroy: [],
      send_receive: [],
    };
    return {
      calls,
      helpers: {
        isZfsSnapshot: (name) => name.includes("@"),
        extractDatasetName: (name) => name.substring(0, name.indexOf("@")),
      },
      zfs: {
        get: async function (dataset, properties, options) {
          calls.get.push({ dataset, properties, options });
          if (
            Array.isArray(properties) &&
            properties.length === 2 &&
            properties[0] === "volsize" &&
            properties[1] === "refquota"
          ) {
            throw new Error(
              `cannot open '${dataset}': dataset does not exist`
            );
          }
          if (dataset === FULL_SNAPSHOT_NAME) {
            return { [FULL_SNAPSHOT_NAME]: snapshotProperties };
          }
          return {
            [dataset]: { mountpoint: snapshotEntry("/" + dataset, "local") },
          };
        },
        clone: async function (snapshotName, datasetName, options) {
          calls.clone.push({ snapshotName, datasetName, options });
          return {};
        },
        set: async function (dataset, properties) {
          calls.set.push({ dataset, properties });
          return {};
        },
        create: async function (dataset, options) {
          calls.create.push({ dataset, options });
          return {};
        },
        snapshot: async function (name, options) {
          calls.snapshot.push({ name, options });
          return {};
        },
        destroy: async function (name, options) {
          calls.destroy.push({ name, options });
          return {};
        },
        send_receive: async function () {
          calls.send_receive.push(Array.from(arguments));
          return {};
        },
      },
    };
  }

  function makeDriver(zb, driverZfsOptions) {
    class TestZfsDriver extends ControllerZfsBaseDriver {
      getDriverZfsResourceType() {
        return "filesystem";
      }
      async getZetabyte() {
        return zb;
      }
      getExecClient() {
        return {
          buildCommand: (...args) => args.join(" "),
          exec: async () => ({ code: 0 }),
        };
      }
      async createShare() {
        return { share: "/export/test" };
      }
    }

    return new TestZfsDriver(
      {
        logger: {
          debug() {},
          verbose() {},
          info() {},
          warn() {},
          error() {},
        },
      },
      Object.assign(
        {
          driver: "zfs-generic-nfs",
          instance_id: "test",
          zfs: Object.assign(
            {
              datasetParentName: "tank/k8s/pvs",
              detachedSnapshotsDatasetParentName: "tank/k8s/snapshots",
              datasetEnableQuotas: false,
              datasetEnableReservation: false,
            },
            driverZfsOptions
          ),
        },
        driverZfsOptions
      )
    );
  }

  function makeCall(parameters = {}, contentSource) {
    return {
      request: Object.assign(
        {
          name: "pvc-test",
          volume_capabilities: [
            {
              access_type: "mount",
              access_mode: { mode: "SINGLE_NODE_WRITER" },
              mount: { fs_type: "nfs" },
            },
          ],
          capacity_range: { required_bytes: 1073741824 },
          parameters,
        },
        contentSource
          ? { volume_content_source: contentSource }
          : {}
      ),
    };
  }

  const snapshotProperties = {
    "syncoid:sync": snapshotEntry(
      "false",
      `inherited from tank/k8s/pvs/pvc-src`
    ),
    "homelab:tier": snapshotEntry("fast", "local"),
    "democratic-csi:managed_resource": snapshotEntry("true", "local"),
    "syncoid:other": snapshotEntry("yes", "inherited from tank/k8s"),
  };

  it("merges copied, set, and overlay properties onto the clone (precedence)", async () => {
    const zb = makeFakeZb(snapshotProperties);
    const driver = makeDriver(zb, {
      datasetProperties: {
        "base:prop": "driver",
        aclmode: "passthrough",
        // copied value must override the driver-level default
        "syncoid:sync": "driver-default",
      },
      cloneDatasetProperties: {
        copy: ["syncoid:sync", "homelab:*"],
        set: { "clone:fixed": "from-driver" },
      },
    });

    const call = makeCall(
      {
        config:
          "zfs:\n  datasetProperties:\n    base:prop: storageclass\n    sc:prop: sc\n  cloneDatasetProperties:\n    set:\n      clone:fixed: from-overlay\n",
      },
      { type: "snapshot", snapshot: { snapshot_id: "pvc-src@snap" } }
    );

    await driver.CreateVolume(call);

    assert.strictEqual(zb.calls.clone.length, 1);
    assert.strictEqual(zb.calls.clone[0].snapshotName, FULL_SNAPSHOT_NAME);
    assert.strictEqual(zb.calls.clone[0].datasetName, DATASET_NAME);

    const props = zb.calls.clone[0].options.properties;
    // driver-generated properties still present
    assert.strictEqual(props["democratic-csi:managed_resource"], "true");
    assert.strictEqual(
      props["democratic-csi:csi_volume_content_source_type"],
      "snapshot"
    );
    // copied from source (beats driver-level datasetProperties)
    assert.strictEqual(props["syncoid:sync"], "false");
    assert.strictEqual(props["homelab:tier"], "fast");
    // ancestor-inherited and reserved values not copied
    assert.strictEqual(props["syncoid:other"], undefined);
    // driver-level < copied is not observable here, but overlay beats driver
    assert.strictEqual(props["base:prop"], "storageclass");
    assert.strictEqual(props["sc:prop"], "sc");
    // cloneDatasetProperties.set applies, overlay cloneDatasetProperties.set wins
    assert.strictEqual(props["clone:fixed"], "from-overlay");
    // acl props removed from the clone
    assert.strictEqual(props.aclmode, undefined);
  });

  it("does not request snapshot properties when cloneDatasetProperties is unset", async () => {
    const zb = makeFakeZb(snapshotProperties);
    const driver = makeDriver(zb);

    const call = makeCall(
      {},
      { type: "snapshot", snapshot: { snapshot_id: "pvc-src@snap" } }
    );

    await driver.CreateVolume(call);

    assert.strictEqual(zb.calls.clone.length, 1);
    // every zfs get is a specific property list, never the snapshot 'all' get
    assert.strictEqual(
      zb.calls.get.filter((c) => c.dataset === FULL_SNAPSHOT_NAME).length,
      0
    );
  });

  it("applies the same properties on the detached (send/receive) path", async () => {
    const zb = makeFakeZb(snapshotProperties);
    const driver = makeDriver(zb, {
      cloneDatasetProperties: { copy: ["syncoid:sync", "homelab:*"] },
    });

    const call = makeCall(
      { detachedVolumesFromSnapshots: "true" },
      { type: "snapshot", snapshot: { snapshot_id: "pvc-src@snap" } }
    );

    await driver.CreateVolume(call);

    assert.strictEqual(zb.calls.send_receive.length, 1);
    // detached path sets the merged properties on the new dataset
    const setCall = zb.calls.set.find(
      (c) => c.dataset === DATASET_NAME && c.properties["syncoid:sync"]
    );
    assert.ok(setCall);
    assert.strictEqual(setCall.properties["syncoid:sync"], "false");
    assert.strictEqual(setCall.properties["homelab:tier"], "fast");
    // acl props are NOT removed on the detached path (behaviour unchanged)
    assert.strictEqual(zb.calls.clone.length, 0);
  });

  it("applies overlay datasetProperties to volumes without a content source", async () => {
    const zb = makeFakeZb();
    const driver = makeDriver(zb);

    const call = makeCall({
      config: "zfs:\n  datasetProperties:\n    sc:prop: sc\n",
    });

    await driver.CreateVolume(call);

    assert.strictEqual(zb.calls.create.length, 1);
    assert.strictEqual(zb.calls.clone.length, 0);
    assert.strictEqual(zb.calls.create[0].options.properties["sc:prop"], "sc");
    // no snapshot-related zfs get
    assert.strictEqual(
      zb.calls.get.filter((c) => c.dataset === FULL_SNAPSHOT_NAME).length,
      0
    );
  });
});
