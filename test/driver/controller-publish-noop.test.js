const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  ControllerZfsBaseDriver,
} = require("../../src/driver/controller-zfs/index");

const { GrpcError, grpc } = require("../../src/utils/grpc");

const DATASET_PARENT = "tank/k8s/pvs";
const VOLUME_ID = "pvc-8c49880-7201-497c-9cc2-88ebf967daac";

/**
 * zetabyte stub: no real zfs/ssh access. `missing` lists datasets that
 * should behave as non-existent ("cannot open ... dataset does not exist").
 */
function fakeZb({ missing = [] } = {}) {
  const calls = { get: [] };
  return {
    calls,
    zfs: {
      get: async function (dataset, properties, options) {
        calls.get.push({ dataset, properties, options });
        if (missing.includes(dataset)) {
          throw new Error(`cannot open '${dataset}': dataset does not exist`);
        }
        return { [dataset]: { name: { value: dataset } } };
      },
    },
  };
}

/**
 * Minimal ControllerZfsBaseDriver subclass: no exec client, no ssh, no
 * share handling - only the controller no-op RPCs under test are exercised.
 */
function makeDriver(zb, driver, driverZfsResourceType, extraOptions = {}) {
  class TestZfsDriver extends ControllerZfsBaseDriver {
    getDriverZfsResourceType() {
      return driverZfsResourceType || "filesystem";
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
        driver,
        instance_id: "test",
        zfs: {
          datasetParentName: DATASET_PARENT,
          detachedSnapshotsDatasetParentName: "tank/k8s/snapshots",
        },
      },
      extraOptions
    )
  );
}

function makePublishCall(overrides = {}) {
  return {
    request: Object.assign(
      {
        volume_id: VOLUME_ID,
        node_id: "node-1",
        volume_capability: {
          access_mode: { mode: "SINGLE_NODE_WRITER" },
        },
        readonly: false,
      },
      overrides
    ),
  };
}

function assertGrpcStatus(err, status) {
  assert.ok(err instanceof GrpcError, `expected GrpcError, got ${err}`);
  assert.strictEqual(err.code, status);
}

describe("default controller capabilities", () => {
  it("includes PUBLISH_UNPUBLISH_VOLUME for zfs-generic-iscsi", () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-iscsi", "volume");

    assert.ok(
      driver.options.service.controller.capabilities.rpc.includes(
        "PUBLISH_UNPUBLISH_VOLUME"
      )
    );
  });

  it("includes PUBLISH_UNPUBLISH_VOLUME for zfs-generic-nvmeof", () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-nvmeof", "volume");

    assert.ok(
      driver.options.service.controller.capabilities.rpc.includes(
        "PUBLISH_UNPUBLISH_VOLUME"
      )
    );
  });

  it("does not include PUBLISH_UNPUBLISH_VOLUME for zfs-generic-nfs", () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-nfs", "filesystem");

    assert.ok(
      !driver.options.service.controller.capabilities.rpc.includes(
        "PUBLISH_UNPUBLISH_VOLUME"
      )
    );
  });

  it("does not include PUBLISH_UNPUBLISH_VOLUME for zfs-generic-smb", () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-smb", "filesystem");

    assert.ok(
      !driver.options.service.controller.capabilities.rpc.includes(
        "PUBLISH_UNPUBLISH_VOLUME"
      )
    );
  });

  it("does not include PUBLISH_UNPUBLISH_VOLUME for zfs-local-dataset", () => {
    const driver = makeDriver(fakeZb(), "zfs-local-dataset", "filesystem");

    assert.ok(
      !driver.options.service.controller.capabilities.rpc.includes(
        "PUBLISH_UNPUBLISH_VOLUME"
      )
    );
  });

  it("does not include PUBLISH_UNPUBLISH_VOLUME for zfs-local-zvol", () => {
    const driver = makeDriver(fakeZb(), "zfs-local-zvol", "volume");

    assert.ok(
      !driver.options.service.controller.capabilities.rpc.includes(
        "PUBLISH_UNPUBLISH_VOLUME"
      )
    );
  });

  it("user-specified caps override the defaults entirely", () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-iscsi", "volume", {
      service: {
        controller: {
          capabilities: {
            rpc: ["CREATE_DELETE_VOLUME", "EXPAND_VOLUME"],
          },
        },
      },
    });

    assert.deepStrictEqual(
      driver.options.service.controller.capabilities.rpc,
      ["CREATE_DELETE_VOLUME", "EXPAND_VOLUME"]
    );
  });
});

describe("ControllerPublishVolume", () => {
  it("returns an empty publish_context without storage calls", async () => {
    const zb = fakeZb();
    const driver = makeDriver(zb, "zfs-generic-iscsi", "volume");

    const response = await driver.ControllerPublishVolume(makePublishCall());

    assert.deepStrictEqual(response, { publish_context: {} });
    // dataset existence is verified, but no storage-side attach happens
    assert.deepStrictEqual(zb.calls.get, [
      {
        dataset: `${DATASET_PARENT}/${VOLUME_ID}`,
        properties: ["name"],
        options: undefined,
      },
    ]);
  });

  it("rejects a missing volume_id with INVALID_ARGUMENT", async () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-iscsi", "volume");

    await assert.rejects(
      driver.ControllerPublishVolume(makePublishCall({ volume_id: undefined })),
      (err) => {
        assertGrpcStatus(err, grpc.status.INVALID_ARGUMENT);
        return true;
      }
    );
  });

  it("rejects an invalid volume_id with INVALID_ARGUMENT", async () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-iscsi", "volume");

    await assert.rejects(
      driver.ControllerPublishVolume(makePublishCall({ volume_id: "a/b@c" })),
      (err) => {
        assertGrpcStatus(err, grpc.status.INVALID_ARGUMENT);
        return true;
      }
    );
  });

  it("rejects a missing node_id with INVALID_ARGUMENT", async () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-iscsi", "volume");

    await assert.rejects(
      driver.ControllerPublishVolume(makePublishCall({ node_id: "" })),
      (err) => {
        assertGrpcStatus(err, grpc.status.INVALID_ARGUMENT);
        return true;
      }
    );
  });

  it("rejects a missing volume_capability with INVALID_ARGUMENT", async () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-iscsi", "volume");

    await assert.rejects(
      driver.ControllerPublishVolume(
        makePublishCall({ volume_capability: undefined })
      ),
      (err) => {
        assertGrpcStatus(err, grpc.status.INVALID_ARGUMENT);
        return true;
      }
    );
  });

  it("rejects with NOT_FOUND when the volume dataset does not exist", async () => {
    const zb = fakeZb({ missing: [`${DATASET_PARENT}/${VOLUME_ID}`] });
    const driver = makeDriver(zb, "zfs-generic-iscsi", "volume");

    await assert.rejects(
      driver.ControllerPublishVolume(makePublishCall()),
      (err) => {
        assertGrpcStatus(err, grpc.status.NOT_FOUND);
        return true;
      }
    );
  });

  it("throws UNIMPLEMENTED when the capability is not advertised", async () => {
    const driver = makeDriver(fakeZb(), "zfs-local-zvol", "volume");

    await assert.rejects(
      driver.ControllerPublishVolume(makePublishCall()),
      (err) => {
        assertGrpcStatus(err, grpc.status.UNIMPLEMENTED);
        return true;
      }
    );
  });

  it("throws UNIMPLEMENTED when user caps omit the capability", async () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-iscsi", "volume", {
      service: {
        controller: {
          capabilities: {
            rpc: ["CREATE_DELETE_VOLUME"],
          },
        },
      },
    });

    await assert.rejects(
      driver.ControllerPublishVolume(makePublishCall()),
      (err) => {
        assertGrpcStatus(err, grpc.status.UNIMPLEMENTED);
        return true;
      }
    );
  });
});

describe("ControllerUnpublishVolume", () => {
  it("returns an empty response without storage calls", async () => {
    const zb = fakeZb();
    const driver = makeDriver(zb, "zfs-generic-iscsi", "volume");

    const response = await driver.ControllerUnpublishVolume({
      request: { volume_id: VOLUME_ID, node_id: "node-1" },
    });

    assert.deepStrictEqual(response, {});
    // unpublish must never touch storage
    assert.deepStrictEqual(zb.calls.get, []);
  });

  it("succeeds without node_id (CSI allows unpublish from all nodes)", async () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-nvmeof", "volume");

    const response = await driver.ControllerUnpublishVolume({
      request: { volume_id: VOLUME_ID },
    });

    assert.deepStrictEqual(response, {});
  });

  it("succeeds when the dataset no longer exists (idempotent)", async () => {
    const zb = fakeZb({ missing: ["everything"] });
    const driver = makeDriver(zb, "zfs-generic-iscsi", "volume");

    const response = await driver.ControllerUnpublishVolume({
      request: { volume_id: VOLUME_ID, node_id: "node-1" },
    });

    assert.deepStrictEqual(response, {});
    assert.deepStrictEqual(zb.calls.get, []);
  });

  it("rejects a missing volume_id with INVALID_ARGUMENT", async () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-iscsi", "volume");

    await assert.rejects(
      driver.ControllerUnpublishVolume({ request: { node_id: "node-1" } }),
      (err) => {
        assertGrpcStatus(err, grpc.status.INVALID_ARGUMENT);
        return true;
      }
    );
  });

  it("rejects an invalid volume_id with INVALID_ARGUMENT", async () => {
    const driver = makeDriver(fakeZb(), "zfs-generic-nvmeof", "volume");

    await assert.rejects(
      driver.ControllerUnpublishVolume({
        request: { volume_id: "bad id!" },
      }),
      (err) => {
        assertGrpcStatus(err, grpc.status.INVALID_ARGUMENT);
        return true;
      }
    );
  });

  it("throws UNIMPLEMENTED when the capability is not advertised", async () => {
    const driver = makeDriver(fakeZb(), "zfs-local-zvol", "volume");

    await assert.rejects(
      driver.ControllerUnpublishVolume({
        request: { volume_id: VOLUME_ID, node_id: "node-1" },
      }),
      (err) => {
        assertGrpcStatus(err, grpc.status.UNIMPLEMENTED);
        return true;
      }
    );
  });
});
