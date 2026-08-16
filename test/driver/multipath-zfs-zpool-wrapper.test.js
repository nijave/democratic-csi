const assert = require("node:assert");
const { describe, it } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The docker/multipath, docker/zfs, and docker/zpool bash wrappers are
// installed as /usr/local/bin/{multipath,zfs,zpool}. The democratic-csi node
// process runs as PID 1 (no init/reaper) and spawns them via
// child_process.spawn with a timeout. If a wrapper runs the real tool WITHOUT
// `exec`, it forks a child and waits: when the spawn timeout kills the
// wrapper, the real tool is reparented to PID 1 = node and, because node only
// reaps what it spawned, becomes a permanent zombie. Prefixing the invocation
// with `exec` makes the real binary replace the wrapper in the same PID that
// node tracks, so node reaps it directly.
//
// These tests prove that behavior functionally: they run the real wrapper
// scripts and assert that the process the wrapper hands off to runs in the
// SAME pid that spawn() reported (exec, in place) rather than a forked
// grandchild pid.

const WRAPPERS = {
  multipath: path.join(__dirname, "..", "..", "docker", "multipath"),
  zfs: path.join(__dirname, "..", "..", "docker", "zfs"),
  zpool: path.join(__dirname, "..", "..", "docker", "zpool"),
};

/**
 * Spawn the real wrapper. Both of its invocation paths (per-dir hit in the
 * /host${p} loop and the env -i fallback) invoke `chroot` by bare name, which
 * resolves through the wrapper's own PATH -- so a fake `chroot` placed first
 * on PATH is what actually runs, with no root or /host required. The fake
 * records its own pid ($$) and parent pid ($PPID).
 *
 * With `exec chroot ...` the fake replaces the bash wrapper in place, so its
 * $$ equals the pid spawn() reported. Without `exec` the wrapper forks the
 * fake as a child, so its $$ differs (and its $PPID is the wrapper's pid).
 */
function runWrapperViaFakeChroot(wrapperPath) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcsi-wrap-"));
    const outFile = path.join(dir, "pids.txt");
    const chrootPath = path.join(dir, "chroot");
    fs.writeFileSync(
      chrootPath,
      '#!/usr/bin/env bash\nprintf \'%s\\n%s\\n\' "$$" "$PPID" > "$DCSI_PID_OUT"\nexit 0\n'
    );
    fs.chmodSync(chrootPath, 0o755);

    const child = spawn(wrapperPath, ["status"], {
      env: {
        PATH: dir + ":" + process.env.PATH,
        DCSI_PID_OUT: outFile,
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
          new Error(
            `fake chroot never ran (wrapper exited ${code}): ${err.message}`
          )
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

describe("multipath/zfs/zpool wrappers exec the real tool in place", () => {
  for (const [name, wrapperPath] of Object.entries(WRAPPERS)) {
    it(`docker/${name} replaces itself (no forked grandchild)`, async () => {
      const { spawnedPid, ownPid, ppid, code } =
        await runWrapperViaFakeChroot(wrapperPath);

      assert.strictEqual(code, 0, "wrapper should exit 0");
      // The exec'd process runs in the same pid spawn() reported. On the
      // pre-fix (forking) wrapper the tool is a child, so ownPid !== spawnedPid
      // and ppid === spawnedPid; this assertion fails, as a regression test
      // should.
      assert.strictEqual(
        ownPid,
        spawnedPid,
        `docker/${name} forked instead of exec'ing: handed-off pid ${ownPid} ` +
          `(parent ${ppid}) != spawned pid ${spawnedPid}`
      );
    });
  }
});

describe("multipath/zfs/zpool wrappers static form", () => {
  for (const [name, wrapperPath] of Object.entries(WRAPPERS)) {
    it(`docker/${name} exec-prefixes every tool invocation`, () => {
      const lines = fs.readFileSync(wrapperPath, "utf8").split("\n");

      // Every line that runs the real tool (via chroot) must be prefixed
      // with `exec`.
      for (const line of lines) {
        const trimmed = line.trim();
        assert.ok(
          !/^chroot /.test(trimmed),
          `docker/${name} has a non-exec tool invocation: ${trimmed}`
        );
      }

      const execCount = lines.filter((l) => /^\s*exec chroot /.test(l)).length;
      assert.strictEqual(
        execCount,
        2,
        `docker/${name} should have 2 exec'd invocations, found ${execCount}`
      );

      // The unreachable post-exec `exit $?` lines must be gone, and so must
      // docker/multipath's stray `echo $?` (which swallowed the tool's exit
      // code even pre-fix).
      assert.ok(
        !/\bexit \$\?/.test(lines.join("\n")),
        `docker/${name} still has an unreachable 'exit $?' after exec`
      );
      assert.ok(
        !/\becho \$\?/.test(lines.join("\n")),
        `docker/${name} still has a stray 'echo $?' after exec`
      );
    });
  }
});
