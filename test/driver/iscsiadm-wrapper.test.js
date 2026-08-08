const assert = require("node:assert");
const { describe, it } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// docker/iscsiadm must `exec` the real tool so it runs in the pid the caller
// tracks; without exec it forks and a killed wrapper orphans iscsiadm to PID 1
// (node reaps only what it spawns) -> zombie. These tests run the real wrapper
// and assert the handed-off process runs in the SAME pid spawn() reported.

const WRAPPER = path.join(__dirname, "..", "..", "docker", "iscsiadm");

/**
 * Run the wrapper with a fake tool first on PATH so no root, /host, or real
 * iscsid is required. The fake records its own pid ($$) and parent pid ($PPID).
 *
 * With `exec <tool> ...` the fake replaces the bash wrapper in place, so its $$
 * equals the pid spawn() reported. Without `exec` the wrapper forks the fake as
 * a child, so its $$ differs (and its $PPID is the wrapper's pid).
 *
 * @param {string} fakeName  bare tool name to shadow on PATH (chroot | nsenter)
 * @param {object} env       extra env vars for the wrapper
 * @param {string[]} extraFakes  additional bare tool names to stub on PATH
 */
function runWrapperViaFake(fakeName, env, extraFakes = []) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcsi-iscsi-"));
    const outFile = path.join(dir, "pids.txt");

    const writeFake = (name, body) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, body);
      fs.chmodSync(p, 0o755);
    };

    // The tool under test records pids then exits 0.
    writeFake(
      fakeName,
      '#!/usr/bin/env bash\nprintf \'%s\\n%s\\n\' "$$" "$PPID" > "$DCSI_PID_OUT"\nexit 0\n'
    );
    // Any helper the wrapper shells out to before the real tool (e.g. pgrep for
    // the nsenter strategy) just needs to succeed with plausible output.
    for (const name of extraFakes) {
      writeFake(name, '#!/usr/bin/env bash\necho 1\nexit 0\n');
    }

    const child = spawn(WRAPPER, ["-m", "session"], {
      env: {
        PATH: dir + ":" + process.env.PATH,
        DCSI_PID_OUT: outFile,
        ...env,
      },
    });

    let spawnError = null;
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("exit", (code) => {
      if (spawnError) {
        reject(spawnError);
        return;
      }
      let raw;
      try {
        raw = fs.readFileSync(outFile, "utf8").trim();
      } catch (err) {
        reject(
          new Error(`fake ${fakeName} never ran (wrapper exited ${code}): ${err.message}`)
        );
        return;
      }
      const [ownPid, ppid] = raw.split("\n");
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({
        spawnedPid: child.pid,
        ownPid: Number(ownPid),
        ppid: Number(ppid),
        code,
      });
    });
  });
}

describe("iscsiadm wrapper execs the real tool in place", () => {
  it("chroot strategy replaces itself (no forked grandchild)", async () => {
    // Default ISCSIADM_HOST_PATH=iscsiadm (not absolute) and no /host tools,
    // so the wrapper falls through to `exec chroot /host /usr/bin/env ...`,
    // where chroot resolves via PATH -> our fake.
    const { spawnedPid, ownPid, ppid, code } = await runWrapperViaFake(
      "chroot",
      { ISCSIADM_HOST_STRATEGY: "chroot" }
    );

    assert.strictEqual(code, 0, "wrapper should exit 0");
    assert.strictEqual(
      ownPid,
      spawnedPid,
      `docker/iscsiadm (chroot) forked instead of exec'ing: handed-off pid ${ownPid} ` +
        `(parent ${ppid}) != spawned pid ${spawnedPid}`
    );
  });

  it("nsenter strategy replaces itself (no forked grandchild)", async () => {
    const { spawnedPid, ownPid, ppid, code } = await runWrapperViaFake(
      "nsenter",
      { ISCSIADM_HOST_STRATEGY: "nsenter" },
      ["pgrep"]
    );

    assert.strictEqual(code, 0, "wrapper should exit 0");
    assert.strictEqual(
      ownPid,
      spawnedPid,
      `docker/iscsiadm (nsenter) forked instead of exec'ing: handed-off pid ${ownPid} ` +
        `(parent ${ppid}) != spawned pid ${spawnedPid}`
    );
  });
});

describe("iscsiadm wrapper static form", () => {
  it("exec-prefixes every real-tool invocation and has no unreachable exit", () => {
    const lines = fs.readFileSync(WRAPPER, "utf8").split("\n");

    // Every line that runs the real tool (chroot or nsenter) must be exec'd.
    for (const line of lines) {
      const trimmed = line.trim();
      assert.ok(
        !/^(chroot |nsenter )/.test(trimmed),
        `docker/iscsiadm has a non-exec tool invocation: ${trimmed}`
      );
    }

    const execCount = lines.filter((l) =>
      /^\s*exec (chroot |nsenter )/.test(l)
    ).length;
    assert.strictEqual(
      execCount,
      4,
      `docker/iscsiadm should have 4 exec'd invocations (3 chroot + 1 nsenter), found ${execCount}`
    );

    // The unreachable post-exec `exit $?` lines must be gone (the exit 1 error
    // branches are expected to remain).
    assert.ok(
      !/\bexit \$\?/.test(lines.join("\n")),
      "docker/iscsiadm still has an unreachable 'exit $?' after exec"
    );
  });
});
