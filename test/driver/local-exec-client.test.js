const assert = require("node:assert");
const cp = require("node:child_process");
const { describe, it } = require("node:test");

const { LocalCliClient } = require("../../src/utils/zfs_local_exec_client");

// LocalCliClient logs through logger.verbose/silly which console lacks
const logger = {
  silly: () => {},
  verbose: () => {},
};

function newClient() {
  return new LocalCliClient({ logger });
}

describe("LocalCliClient.buildCommand", () => {
  it("single-quote wraps every token", () => {
    const client = newClient();
    assert.strictEqual(
      client.buildCommand("chmod", ["0777", "/mnt/some path"]),
      "'chmod' '0777' '/mnt/some path'"
    );
  });

  it("escapes embedded single quotes with the '\\'' idiom", () => {
    const client = newClient();
    assert.strictEqual(
      client.buildCommand("echo", ["it's"]),
      `'echo' 'it'\\''s'`
    );
  });

  it("passes metacharacter-laden args through the shell literally", () => {
    const client = newClient();
    const evil = "$(id) `whoami` ; rm -rf / | & > < \"quoted\" 'sq'";
    const built = client.buildCommand("printf", ["%s", evil]);
    const stdout = cp.execSync(built, { encoding: "utf8" });
    assert.strictEqual(stdout, evil);
  });

  // regression: 4a5832f removed the manual quote-wrap in
  // pcsCommand/targetCliCommand/nvmetCliCommand/spdkCliCommand assuming
  // buildCommand escapes; unescaped join produced `sh -c echo "..." | cli`
  // where the whole config script became $0 of a nested shell and the CLI
  // received empty stdin (silent no-op CreateVolume/DeleteVolume)
  it("keeps a piped config script as the single -c argument", () => {
    const client = newClient();
    const pipeline = 'echo "<script>" | targetcli';
    const built = client.buildCommand("sh", ["-c", pipeline]);
    assert.strictEqual(built, `'sh' '-c' 'echo "<script>" | targetcli'`);

    // parse the built string with a real shell and capture the resulting
    // argv (node stands in for sh so we can print it)
    const argvProbe = client.buildCommand(process.execPath, [
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)))",
      pipeline,
    ]);
    const argv = JSON.parse(cp.execSync(argvProbe, { encoding: "utf8" }));
    assert.deepStrictEqual(argv, [pipeline]);
  });

  it("end to end: built sh -c pipeline executes and produces output", async () => {
    const client = newClient();
    const response = await client.exec(
      client.buildCommand("sh", ["-c", 'echo "hello" | cat'])
    );
    // with the unescaped join this was "\n": `sh -c echo "hello" | cat`
    // makes "hello" the nested shell's $0 and echo prints nothing
    assert.strictEqual(response.stdout, "hello\n");
    assert.strictEqual(response.code, 0);
  });
});
