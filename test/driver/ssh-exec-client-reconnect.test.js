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

describe("SshClient reconnect", () => {
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
});
