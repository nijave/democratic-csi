const assert = require("node:assert");
const { describe, it, before, after } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SshClient } = require("../../src/utils/zfs_ssh_exec_client");

// SshClient.buildCommand() single-quote-escapes every arg before joining, so
// callers must pass each arg raw. These tests guard the `sh -c "..."` pattern
// used by the freenas ssh driver's expandVolume() (SCST resync_size on SCALE):
// manually double-quote-wrapping the -c payload used to be required when
// buildCommand was a plain join(" "), but now it makes the remote shell treat
// the whole double-quoted text as a command name (exit 127).
//
// The built string is executed remotely by the login shell of the ssh user
// (`$SHELL -c <string>`), which `sh -c <string>` emulates locally.
function runBuiltCommand(builtCommand) {
  return spawnSync("sh", ["-c", builtCommand], { encoding: "utf8" });
}

describe("SshClient.buildCommand arg escaping", () => {
  let client;
  let tmpDir;

  before(() => {
    client = new SshClient({ connection: {} });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcsi-escape-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("single-quote-escapes each arg into one shell word", () => {
    const command = client.buildCommand("sh", ["-c", "echo 1 > /some/path"]);
    assert.strictEqual(command, `'sh' '-c' 'echo 1 > /some/path'`);
  });

  it("raw -c payload round-trips through a real sh (fixed form)", () => {
    const target = path.join(tmpDir, "resync_size_fixed");
    // mirrors src/driver/freenas/ssh.js expandVolume(): raw string, no manual
    // quote wrapping
    const command = client.buildCommand("sh", ["-c", `echo 1 > ${target}`]);

    const result = runBuiltCommand(command);
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    assert.strictEqual(fs.readFileSync(target, "utf8").trim(), "1");
  });

  it("old double-quote-wrapped -c payload fails with command-not-found", () => {
    const target = path.join(tmpDir, "resync_size_broken");
    // the pre-fix anti-pattern: manual "..." wrap around the -c payload
    const command = client.buildCommand("sh", [
      "-c",
      `"echo 1 > ${target}"`,
    ]);

    const result = runBuiltCommand(command);
    // the inner shell looks up the entire double-quoted text as a command
    // name -> 127, and nothing is written
    assert.strictEqual(result.status, 127);
    assert.strictEqual(fs.existsSync(target), false);
  });
});
