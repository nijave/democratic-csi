const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  validateVolumeId,
  validateSnapshotId,
} = require("../../src/driver/index");
const { grpc } = require("../../src/utils/grpc");

function isInvalidArgument(err) {
  return err && err.code === grpc.status.INVALID_ARGUMENT;
}

// payloads that must never be accepted by either validator
const INJECTION_PAYLOADS = [
  "x@y; touch /pwned #",
  "../../etc",
  "..",
  ".",
  "a b",
  "foo`whoami`",
  "foo$(id)",
  "foo|bar",
  "foo&bar",
  "foo>bar",
  "foo\nbar",
  "foo\0bar",
  "'; rm -rf /",
  "foo\\bar",
];

describe("validateVolumeId", () => {
  it("accepts legitimate volume ids", () => {
    const valid = [
      "pvc-8c49880-7201-497c-9cc2-88ebf967daac",
      "my-volume_1",
      "a",
      "A1B2C3",
      "vol0",
    ];
    for (const id of valid) {
      assert.doesNotThrow(() => validateVolumeId(id), `expected accept: ${id}`);
      assert.strictEqual(validateVolumeId(id), id);
    }
  });

  it("rejects injection / traversal payloads", () => {
    for (const id of INJECTION_PAYLOADS) {
      assert.throws(
        () => validateVolumeId(id),
        isInvalidArgument,
        `expected reject: ${JSON.stringify(id)}`
      );
    }
  });

  it("rejects ids not starting with an alphanumeric", () => {
    for (const id of ["-foo", "_foo"]) {
      assert.throws(() => validateVolumeId(id), isInvalidArgument);
    }
  });

  it("rejects empty / non-string / oversized ids", () => {
    assert.throws(() => validateVolumeId(""), isInvalidArgument);
    assert.throws(() => validateVolumeId(undefined), isInvalidArgument);
    assert.throws(() => validateVolumeId(null), isInvalidArgument);
    assert.throws(() => validateVolumeId("a".repeat(129)), isInvalidArgument);
  });

  it("rejects '@' and '/' (those belong only to snapshot ids)", () => {
    assert.throws(() => validateVolumeId("vol@snap"), isInvalidArgument);
    assert.throws(() => validateVolumeId("vol/snap"), isInvalidArgument);
  });
});

describe("validateSnapshotId", () => {
  it("accepts legitimate zfs snapshot ids", () => {
    const valid = [
      "pvc-8c49880-7201-497c-9cc2-88ebf967daac@snapshot-1",
      "myvol@snapshot-2023.01.02",
      "myvol@snap:with.punct+1",
      // detached snapshot form uses '/'
      "myvol/snapshot-abc",
      "vol0@s0",
    ];
    for (const id of valid) {
      assert.doesNotThrow(
        () => validateSnapshotId(id),
        `expected accept: ${id}`
      );
      assert.strictEqual(validateSnapshotId(id), id);
    }
  });

  it("rejects injection / traversal payloads", () => {
    for (const id of INJECTION_PAYLOADS) {
      assert.throws(
        () => validateSnapshotId(id),
        isInvalidArgument,
        `expected reject: ${JSON.stringify(id)}`
      );
    }
  });

  it("rejects '..' path segments even with legal separators", () => {
    for (const id of ["vol/..", "../snap", "vol@..", "..@snap", "vol/../x"]) {
      assert.throws(
        () => validateSnapshotId(id),
        isInvalidArgument,
        `expected reject: ${id}`
      );
    }
  });

  it("rejects empty separator segments", () => {
    for (const id of ["vol@", "@snap", "vol//snap", "vol@@snap"]) {
      assert.throws(() => validateSnapshotId(id), isInvalidArgument);
    }
  });

  it("rejects empty / non-string / oversized ids", () => {
    assert.throws(() => validateSnapshotId(""), isInvalidArgument);
    assert.throws(() => validateSnapshotId(undefined), isInvalidArgument);
    assert.throws(() => validateSnapshotId("a".repeat(256)), isInvalidArgument);
  });
});
