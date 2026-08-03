const assert = require("node:assert");
const cp = require("node:child_process");
const events = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, after } = require("node:test");

const {
  Zetabyte,
  ZfsSshProcessManager,
  shellEscapeArg,
} = require("../../src/utils/zfs");
const LocalCliExecClient =
  require("../../src/utils/zfs_local_exec_client").LocalCliClient;
const { SshClient } = require("../../src/utils/zfs_ssh_exec_client");

/**
 * Args that cover every class of shell metacharacter an attacker (or an
 * unlucky config value) could smuggle into a dataset name, snapshot name or
 * property value.
 */
const HOSTILE_ARGS = [
  "tank/pvc-4d1c6c0f@snap-2026-08-15", // @-snapshot name
  "com.sun:auto-snapshot=false", // property assignment
  "org.test:note=has spaces and a\ttab", // property value with whitespace
  'org.test:json={"a":"b c","d":1}', // JSON property value (double quotes)
  "it's got 'single' quotes", // embedded single quotes
  "$(reboot)", // command substitution
  "`reboot`", // backtick substitution
  "a;rm -rf /", // command separator
  "x|cat /etc/shadow", // pipe
  "y&&touch /pwned", // logical and
  "z>should_not_redirect", // redirection
  "star*glob?[chars]", // glob characters
  "multi\nline", // newline
  "~root", // tilde expansion
  "$HOME and ${HOME}", // parameter expansion
];

/**
 * Run a built command line the same way a remote sshd (or cp.exec) does -
 * through `sh -c` - and recover the exact argv the executed program saw.
 * Uses `printf '%s\0' "$@"` semantics via a NUL separator so embedded
 * newlines round-trip too.
 */
function shellArgv(commandLine) {
  return new Promise((resolve, reject) => {
    cp.exec(commandLine, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`command failed: ${err.message} stderr: ${stderr}`));
        return;
      }
      const parts = stdout.split("\0");
      parts.pop(); // trailing separator
      resolve(parts);
    });
  });
}

function fakeSshClient() {
  return {
    logger: { verbose() {}, silly() {} },
    debug() {},
    async exec() {
      throw new Error("not implemented");
    },
  };
}

/**
 * SshClient stand-in whose exec() runs the received command line through a
 * real local shell - exactly what sshd does with the command string on the
 * remote end - and pumps the results back through the stream proxy.
 */
function fakeSshShellClient() {
  return {
    logger: { verbose() {}, silly() {} },
    debug() {},
    exec(command, options, proxy) {
      return new Promise((resolve) => {
        cp.exec(command, (err, stdout, stderr) => {
          if (stdout) proxy.stdout.emit("data", stdout);
          if (stderr) proxy.stderr.emit("data", stderr);
          proxy.emit("close", err ? (err.code === undefined ? 1 : err.code) : 0);
          resolve();
        });
      });
    },
  };
}

/**
 * Capturing Zetabyte executor: records every spawn() invocation and returns
 * a child-process-alike that immediately closes successfully.
 */
function capturingExecutor() {
  const calls = [];
  return {
    calls,
    spawn: function (command, args, options) {
      calls.push({ command, args: args.slice(), options });
      const child = new events.EventEmitter();
      child.stdout = new events.EventEmitter();
      child.stderr = new events.EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit("close", 0));
      return child;
    },
  };
}

describe("shellEscapeArg", () => {
  it("produces a single shell word whose value is exactly the input", async () => {
    for (const arg of HOSTILE_ARGS) {
      const argv = await shellArgv(
        `printf ${shellEscapeArg("%s\\0")} ${shellEscapeArg(arg)}`
      );
      assert.deepStrictEqual(argv, [arg]);
    }
  });

  it("stringifies non-string values", () => {
    assert.strictEqual(shellEscapeArg(5), "'5'");
    assert.strictEqual(shellEscapeArg(true), "'true'");
  });
});

describe("ZfsSshProcessManager.buildCommand", () => {
  const manager = new ZfsSshProcessManager(fakeSshClient());

  it("escapes every token", async () => {
    // the escaped "%s\\0" format arg is consumed by printf itself; the
    // remaining argv tokens round-trip through the shell verbatim
    const command = manager.buildCommand("printf", [
      "%s\\0",
      ...HOSTILE_ARGS,
    ]);
    assert.deepStrictEqual(await shellArgv(command), HOSTILE_ARGS);
  });

  it("neutralizes command injection in a dataset-name position", async () => {
    const canary = path.join(
      os.tmpdir(),
      `democratic-csi-injection-canary-${process.pid}`
    );
    const command = manager.buildCommand("printf", [
      "%s\\0",
      `tank/pvc; touch ${canary}`,
      `$(touch ${canary})`,
    ]);
    const argv = await shellArgv(command);
    assert.strictEqual(fs.existsSync(canary), false);
    assert.deepStrictEqual(argv, [
      `tank/pvc; touch ${canary}`,
      `$(touch ${canary})`,
    ]);
  });

  it("matches SshClient.buildCommand output", () => {
    const args = () => HOSTILE_ARGS.slice(); // both implementations unshift
    assert.strictEqual(
      manager.buildCommand("zfs", args()),
      SshClient.prototype.buildCommand.call(
        { shellEscapeArg: SshClient.prototype.shellEscapeArg },
        "zfs",
        args()
      )
    );
  });
});

describe("LocalCliExecClient.buildCommand", () => {
  it("escapes every token", async () => {
    const client = new LocalCliExecClient({
      logger: { verbose() {}, silly() {} },
    });
    const command = client.buildCommand("printf", ["%s\\0", ...HOSTILE_ARGS]);
    assert.deepStrictEqual(await shellArgv(command), HOSTILE_ARGS);
  });
});

describe("Zetabyte call-site arg shapes (captured executor)", () => {
  function zbWith(executor, options = {}) {
    return new Zetabyte({ executor, ...options });
  }

  it("zfs.set passes property values raw (no pre-quoting)", async () => {
    const executor = capturingExecutor();
    const zb = zbWith(executor);
    await zb.zfs.set("tank/ds", {
      "democratic-csi:csi_volume_name": 'pvc has "spaces" and \'quotes\'',
      "org.test:empty": "",
    });
    assert.strictEqual(executor.calls.length, 1);
    assert.strictEqual(executor.calls[0].command, "/sbin/zfs");
    assert.deepStrictEqual(executor.calls[0].args, [
      "set",
      'democratic-csi:csi_volume_name=pvc has "spaces" and \'quotes\'',
      "org.test:empty=",
      "tank/ds",
    ]);
  });

  it("zfs.create passes -o properties raw", async () => {
    const executor = capturingExecutor();
    const zb = zbWith(executor);
    await zb.zfs.create("tank/ds", {
      parents: true,
      properties: {
        "com.sun:auto-snapshot": "false",
        mountpoint: "/var/lib/kubelet/pods/x y/mount",
      },
    });
    assert.deepStrictEqual(executor.calls[0].args, [
      "create",
      "-p",
      "-o",
      "com.sun:auto-snapshot=false",
      "-o",
      "mountpoint=/var/lib/kubelet/pods/x y/mount",
      "tank/ds",
    ]);
  });

  it("zfs.clone passes -o properties raw", async () => {
    const executor = capturingExecutor();
    const zb = zbWith(executor);
    await zb.zfs.clone("tank/ds@snap", "tank/clone", {
      properties: { volsize: "1073741824" },
    });
    assert.deepStrictEqual(executor.calls[0].args, [
      "clone",
      "-o",
      "volsize=1073741824",
      "tank/ds@snap",
      "tank/clone",
    ]);
  });

  it("zfs.snapshot keeps each dataset of an array a separate argument", async () => {
    const executor = capturingExecutor();
    const zb = zbWith(executor);
    await zb.zfs.snapshot(["tank/a@snap", "tank/b@snap"]);
    assert.deepStrictEqual(executor.calls[0].args, [
      "snapshot",
      "tank/a@snap",
      "tank/b@snap",
    ]);
  });

  it("zfs.send_receive passes the pipeline as one raw sh -c argument", async () => {
    const executor = capturingExecutor();
    const zb = zbWith(executor);
    await zb.zfs.send_receive("tank/v@snap", [], "tank/v2", []);
    assert.strictEqual(executor.calls.length, 1);
    assert.strictEqual(executor.calls[0].command, "/bin/sh");
    assert.deepStrictEqual(executor.calls[0].args, [
      "-c",
      "zfs send 'tank/v@snap' | zfs receive 'tank/v2'",
    ]);
    // sudo is embedded in the payload, never prefixed onto sh itself
    assert.strictEqual(executor.calls[0].options.sudo, false);
  });

  it("zfs.send_receive embeds sudo inside the pipeline when enabled", async () => {
    const executor = capturingExecutor();
    const zb = zbWith(executor, { sudo: true });
    await zb.zfs.send_receive("tank/v@snap", [], "tank/v2", []);
    assert.strictEqual(executor.calls[0].command, "/bin/sh");
    assert.deepStrictEqual(executor.calls[0].args, [
      "-c",
      "/usr/bin/sudo zfs send 'tank/v@snap' | /usr/bin/sudo zfs receive 'tank/v2'",
    ]);
  });

  it("sudo and chroot compose as separate argv tokens", async () => {
    const executor = capturingExecutor();
    const zb = zbWith(executor, { sudo: true, chroot: "/host" });
    await zb.zfs.destroy("tank/ds", { recurse: true });
    assert.strictEqual(executor.calls[0].command, "/usr/bin/sudo");
    assert.deepStrictEqual(executor.calls[0].args, [
      "/usr/sbin/chroot",
      "/host",
      "/sbin/zfs",
      "destroy",
      "-r",
      "-p",
      "tank/ds",
    ]);
  });
});

describe("end to end: Zetabyte over ZfsSshProcessManager through a real shell", () => {
  // stand-in zfs binary that reports the exact argv it received
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "democratic-csi-zfs-"));
  const argvBin = path.join(tmpDir, "argv.sh");
  fs.writeFileSync(argvBin, `#!/bin/sh\nprintf '%s\\0' "$@"\n`, {
    mode: 0o755,
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function zb() {
    return new Zetabyte({
      executor: new ZfsSshProcessManager(fakeSshShellClient()),
      paths: { zfs: argvBin, zpool: argvBin },
    });
  }

  it("delivers hostile dataset names and property values verbatim", async () => {
    const dataset = "tank/pvc with spaces;$(evil)|`worse`";
    const value = "it's a \"mixed\" value\nwith a newline";
    const stdout = await zb().zfs.set(dataset, { "org.test:v": value });
    const argv = stdout.split("\0");
    argv.pop();
    assert.deepStrictEqual(argv, ["set", `org.test:v=${value}`, dataset]);
  });

  it("delivers @-snapshot names verbatim", async () => {
    const snapshot = "tank/pvc-1@snap with space&&touch /pwned";
    const stdout = await zb().zfs.destroy(snapshot, {
      recurse: true,
      defer: true,
    });
    const argv = stdout.split("\0");
    argv.pop();
    assert.deepStrictEqual(argv, ["destroy", "-r", "-p", "-d", snapshot]);
  });
});
