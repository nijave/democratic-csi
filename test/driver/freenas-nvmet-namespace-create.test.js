const assert = require("node:assert");
const { describe, it } = require("node:test");

const { Api } = require("../../src/driver/freenas/http/api");

// NvmetNamespaceCreate resolves a 422 conflict by looking the namespace up
// via NvmetNamespaceGetByDeivcePath, which filters only by device_path. With
// stale state (an orphaned namespace left under a different subsystem for a
// reused zvol path) that lookup can return a namespace belonging to another
// subsystem, so the conflict path must verify subsystem ownership before
// adopting the record (nijave/democratic-csi#42).

const ZVOL = "tank/k8s/v/pvc-111";
const DEVICE_PATH = `zvol/${ZVOL}`;

/**
 * Minimal httpClient stub covering the two calls NvmetNamespaceCreate makes:
 * POST /nvmet/namespace (create) and GET /nvmet/namespace (conflict lookup).
 * The version probe is satisfied from the cache stub, so no other endpoints
 * are hit.
 */
function fakeHttpClient({ postResponse, getResponse } = {}) {
  const calls = { post: [], get: [] };
  return {
    calls,
    async post(endpoint, data) {
      calls.post.push({ endpoint, data });
      return postResponse;
    },
    async get(endpoint, data) {
      calls.get.push({ endpoint, data });
      return getResponse;
    },
  };
}

function buildApi(httpClient) {
  // pre-populated version cache keeps getSystemVersionSemver() (>=25.10
  // required for nvmet) off the network
  const cache = {
    async get() {
      return { v2: "TrueNAS-25.10.0" };
    },
    async set() {},
  };
  return new Api(httpClient, cache);
}

function conflict422(message) {
  return {
    statusCode: 422,
    body: { message },
  };
}

describe("NvmetNamespaceCreate", () => {
  it("returns the created namespace on 200 without a lookup", async () => {
    const created = { id: 5, nsid: 1, device_path: DEVICE_PATH };
    const httpClient = fakeHttpClient({
      postResponse: { statusCode: 200, body: created },
    });
    const api = buildApi(httpClient);

    const namespace = await api.NvmetNamespaceCreate(ZVOL, 7);

    assert.deepStrictEqual(namespace, created);
    assert.strictEqual(httpClient.calls.get.length, 0);
    assert.strictEqual(httpClient.calls.post[0].data.subsys_id, 7);
    assert.strictEqual(httpClient.calls.post[0].data.device_path, DEVICE_PATH);
  });

  it("adopts the existing namespace on conflict when the subsystem matches", async () => {
    const existing = {
      id: 5,
      nsid: 1,
      subsys: { id: 7, name: "csi-pvc-111-clustera" },
      device_path: DEVICE_PATH,
    };
    const httpClient = fakeHttpClient({
      postResponse: conflict422(
        "This device_path already used by subsystem: csi-pvc-111-clustera"
      ),
      getResponse: { statusCode: 200, body: [existing] },
    });
    const api = buildApi(httpClient);

    const namespace = await api.NvmetNamespaceCreate(ZVOL, 7);

    assert.deepStrictEqual(namespace, existing);
    // lookup filters by device_path only, hence the ownership check above
    assert.deepStrictEqual(httpClient.calls.get[0].data, {
      device_path: DEVICE_PATH,
    });
  });

  it("accepts a flat subsys_id field on the looked-up record", async () => {
    const existing = { id: 5, nsid: 1, subsys_id: 7, device_path: DEVICE_PATH };
    const httpClient = fakeHttpClient({
      postResponse: conflict422("namespace already exists"),
      getResponse: { statusCode: 200, body: [existing] },
    });
    const api = buildApi(httpClient);

    const namespace = await api.NvmetNamespaceCreate(ZVOL, 7);

    assert.deepStrictEqual(namespace, existing);
  });

  it("throws instead of adopting a namespace owned by another subsystem", async () => {
    const orphaned = {
      id: 5,
      nsid: 1,
      subsys: { id: 3, name: "csi-pvc-111-clusterb" },
      device_path: DEVICE_PATH,
    };
    const httpClient = fakeHttpClient({
      postResponse: conflict422(
        "This device_path already used by subsystem: csi-pvc-111-clusterb"
      ),
      getResponse: { statusCode: 200, body: [orphaned] },
    });
    const api = buildApi(httpClient);

    await assert.rejects(api.NvmetNamespaceCreate(ZVOL, 7), (err) => {
      assert.match(err.message, /already exists but belongs to subsys_id 3/);
      assert.match(err.message, /expected 7/);
      assert.match(err.message, new RegExp(DEVICE_PATH));
      return true;
    });
  });
});
