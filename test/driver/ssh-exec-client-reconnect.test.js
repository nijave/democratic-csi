const assert = require("node:assert");
const { describe, it, afterEach } = require("node:test");
const { Server, utils } = require("ssh2");

const { SshClient } = require("../../src/utils/zfs_ssh_exec_client");

// These tests run SshClient against an in-process ssh2 Server so the real
// ssh2 Client state machine (connect/end/close ordering, channel manager
// cleanup) is exercised rather than a mock of it.

const HOST_KEY = utils.generateKeyPairSync("ed25519").private;

const quietLogger = {
  silly() {},
  debug() {},
  verbose() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Start an ssh server on 127.0.0.1.
 *
 * onExec(info, stream) is called for each exec request; it owns the stream.
 */
function startServer(onExec) {
  const state = { connections: 0, clients: new Set(), execStreams: new Set() };
  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    state.connections++;
    client.on("error", () => {});
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, rejectExec, info) => {
          const stream = acceptExec();
          state.execStreams.add(stream);
          stream.on("close", () => state.execStreams.delete(stream));
          // drain stdin so the channel can reach 'close' when the client
          // closes it
          stream.resume();
          onExec(info, stream);
        });
      });
    });
  });
  // "connection" hands us the server-side ssh2 connection, not the socket
  server.on("connection", (conn) => {
    state.clients.add(conn);
    conn.on("close", () => state.clients.delete(conn));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.port = server.address().port;
      state.server = server;
      state.dropAll = () => {
        for (const conn of state.clients) {
          conn.end();
        }
      };
      state.close = () =>
        new Promise((r) => {
          state.dropAll();
          server.close(() => r());
        });
      resolve(state);
    });
  });
}

function replyAfter(ms, output = "ok", code = 0) {
  return (info, stream) => {
    setTimeout(() => {
      try {
        stream.write(output);
        stream.exit(code);
        stream.end();
      } catch {}
    }, ms);
  };
}

function newClient(port, extra = {}) {
  return new SshClient({
    logger: quietLogger,
    connection: {
      host: "127.0.0.1",
      port,
      username: "test",
      password: "test",
      keepaliveInterval: 0,
    },
    ...extra,
  });
}

/**
 * Resolve to {status, value|reason}, or {status: "hung"} if the promise has
 * not settled within ms.
 */
function settleWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: "hung" }), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForEvent(emitter, name) {
  return new Promise((resolve) => emitter.once(name, resolve));
}

describe("SshClient reconnect and exec timeouts", () => {
  let server;
  let client;

  afterEach(async () => {
    if (client && client.conn) {
      try {
        client.conn.end();
      } catch {}
    }
    client = null;
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("reconnects once and settles every exec after a dropped connection", async () => {
    server = await startServer(replyAfter(150));
    client = newClient(server.port, { execTimeoutMs: 0 });

    const first = await client.exec("echo warmup");
    assert.strictEqual(first.code, 0);
    assert.strictEqual(server.connections, 1);

    // drop the shared connection from the server side, as in the incident
    const closed = waitForEvent(client.conn, "close");
    server.dropAll();
    await closed;

    // burst of concurrent execs, like the CreateVolume burst
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        settleWithin(client.exec(`echo ${i}`), 5000)
      )
    );

    const hung = results.filter((r) => r.status === "hung").length;
    assert.strictEqual(hung, 0, `${hung} exec(s) never settled`);
    for (const r of results) {
      assert.strictEqual(r.status, "fulfilled", String(r.reason));
      assert.strictEqual(r.value.code, 0);
      assert.strictEqual(r.value.stdout, "ok");
    }
    // exactly one reconnect for the whole burst
    assert.strictEqual(server.connections, 2);
  });

  it("does not open a new connection while the current one is ready", async () => {
    server = await startServer(replyAfter(50));
    client = newClient(server.port, { execTimeoutMs: 0 });

    await Promise.all(
      Array.from({ length: 16 }, (_, i) => client.exec(`echo ${i}`))
    );
    await Promise.all(
      Array.from({ length: 16 }, (_, i) => client.exec(`echo ${i}`))
    );
    assert.strictEqual(server.connections, 1);
  });

  it("rejects and closes the channel when an exec exceeds the timeout", async () => {
    // never reply
    server = await startServer(() => {});
    client = newClient(server.port, { execTimeoutMs: 300 });

    const proxyEvents = [];
    const { EventEmitter } = require("node:events");
    const proxy = new EventEmitter();
    proxy.stdout = new EventEmitter();
    proxy.stderr = new EventEmitter();
    proxy.on("close", () => proxyEvents.push("close"));

    const result = await settleWithin(
      client.exec("sleep 999", {}, proxy),
      5000
    );
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason.message, /timed out after 300ms/);
    assert.strictEqual(result.reason.code, "ETIMEDOUT");

    // the client destroyed the channel, so the server sees it close
    const deadline = Date.now() + 2000;
    while (server.execStreams.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(server.execStreams.size, 0);
    // the late stream close must not be proxied after the promise settled
    assert.deepStrictEqual(proxyEvents, []);

    // the shared connection is still usable afterwards
    assert.strictEqual(client.conn_state, "ready");
  });

  it("rejects an in-flight exec when the connection closes underneath it", async () => {
    server = await startServer(() => {});
    client = newClient(server.port, { execTimeoutMs: 0 });

    await client.connect();
    const pending = settleWithin(client.exec("sleep 999"), 5000);
    // let the channel open on the server
    const deadline = Date.now() + 2000;
    while (server.execStreams.size === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    server.dropAll();

    const result = await pending;
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason.message, /connection (closed|ended)/);
  });

  it("rejects (instead of hanging) when the connection cannot be made", async () => {
    // grab a free port, then close the server so nothing listens on it
    server = await startServer(() => {});
    const port = server.port;
    await server.close();
    server = null;
    client = newClient(port, { execTimeoutMs: 0 });

    const result = await settleWithin(client.exec("true"), 5000);
    assert.strictEqual(result.status, "rejected");
    assert.match(String(result.reason), /ECONNREFUSED/);
  });

  it("times out a non-reused connection exec", async () => {
    server = await startServer(() => {});
    client = newClient(server.port, { execTimeoutMs: 300 });

    const result = await settleWithin(client._nexec("sleep 999"), 5000);
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason.message, /timed out after 300ms/);
  });

  it("reads the exec timeout from SSH_EXEC_TIMEOUT_MS", () => {
    const prev = process.env.SSH_EXEC_TIMEOUT_MS;
    try {
      delete process.env.SSH_EXEC_TIMEOUT_MS;
      assert.strictEqual(newClient(1).getExecTimeoutMs(), 15 * 60 * 1000);
      process.env.SSH_EXEC_TIMEOUT_MS = "1234";
      assert.strictEqual(newClient(1).getExecTimeoutMs(), 1234);
      process.env.SSH_EXEC_TIMEOUT_MS = "0";
      assert.strictEqual(newClient(1).getExecTimeoutMs(), 0);
      process.env.SSH_EXEC_TIMEOUT_MS = "bogus";
      assert.strictEqual(newClient(1).getExecTimeoutMs(), 15 * 60 * 1000);
      // explicit option wins
      assert.strictEqual(
        newClient(1, { execTimeoutMs: 5 }).getExecTimeoutMs(),
        5
      );
    } finally {
      if (prev === undefined) {
        delete process.env.SSH_EXEC_TIMEOUT_MS;
      } else {
        process.env.SSH_EXEC_TIMEOUT_MS = prev;
      }
    }
  });
});
