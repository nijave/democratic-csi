const Client = require("ssh2").Client;
const { Mutex } = require("async-mutex");
const GeneralUtils = require("./general");

// Upper bound for a single ssh exec. zfs operations (notably zfs
// send | receive for detached clones) can be slow, so this is generous; it
// only exists so an exec that can never complete fails instead of hanging
// its caller (and the CSI operation lock) forever.
const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60 * 1000;

class SshClient {
  constructor(options = {}) {
    const client = this;
    this.options = options;
    this.options.connection = this.options.connection || {};
    if (this.options.logger) {
      this.logger = this.options.logger;
    } else {
      this.logger = console;
      console.silly = console.debug;
    }

    if (!this.options.connection.hasOwnProperty("keepaliveInterval")) {
      this.options.connection.keepaliveInterval = 10000;
    }

    if (this.options.connection.debug === true) {
      this.options.connection.debug = function (msg) {
        client.debug(msg);
      };
    }

    this.conn_mutex = new Mutex();
    this.conn_state;
    this.conn_err;
    this.ready_event_count = 0;
    this.error_event_count = 0;

    // A fresh ssh2 Client is created for every (re)connect; see _connect().
    this.conn = null;
  }

  /**
   * Create a new ssh2 Client and wire up state tracking.
   *
   * Events from a client that has since been replaced only update
   * this.conn_state while it is still the current client, so a late
   * 'close' from an old connection cannot mark the new one as closed.
   */
  _createConnection() {
    const conn = new Client();
    // every in-flight exec attaches end/close listeners; a burst of
    // concurrent calls would otherwise trip MaxListenersExceededWarning
    conn.setMaxListeners(0);
    const isCurrent = () => this.conn === conn;

    // invoked before close
    conn.on("end", () => {
      if (isCurrent()) this.conn_state = "ended";
      this.debug("Client :: end");
    });
    // invoked after end
    conn.on("close", () => {
      if (isCurrent()) this.conn_state = "closed";
      this.debug("Client :: close");
    });
    conn.on("error", (err) => {
      if (isCurrent()) {
        this.conn_state = "error";
        this.conn_err = err;
      }
      this.error_event_count++;
      this.debug("Client :: error");
    });
    conn.on("ready", () => {
      if (isCurrent()) this.conn_state = "ready";
      this.ready_event_count++;
      this.debug("Client :: ready");
    });

    return conn;
  }

  /**
   * Shell-escape a single argument (POSIX single-quote wrapping).
   * @param {*} arg
   */
  shellEscapeArg(arg) {
    return `'${String(arg).replace(/'/g, `'\\''`)}'`;
  }

  /**
   * Build a command line from name + args, shell-escaping every token.
   * @param {*} name
   * @param {*} args
   */
  buildCommand(name, args = []) {
    args.unshift(name);
    return args.map((arg) => this.shellEscapeArg(arg)).join(" ");
  }

  debug() {
    this.logger.silly(...arguments);
  }

  /**
   * (Re)connect under conn_mutex and return a ready ssh2 Client.
   *
   * Callers that queued on the mutex while another caller reconnected see
   * the ready state on entry and return the existing client instead of
   * reconnecting again.
   *
   * We never call connect() on an existing Client. In ssh2 (1.17.0) calling
   * connect() on a client whose socket is still open does
   * `this.once('close', () => this.connect(cfg)); this.end()`. The socket
   * 'close' handler emits 'close' (re-entering connect(), which replaces
   * this._chanMgr) before it runs `this._chanMgr.cleanup(err)`, so cleanup
   * runs on the new, empty channel manager and every in-flight exec channel
   * of the old connection is orphaned: its callback and stream 'close'
   * never fire. A new Client per connection keeps the old client's cleanup
   * on its own channel manager, which errors its channels out.
   */
  async _connect() {
    return this.conn_mutex.runExclusive(async () => {
      if (this.conn && this.conn_state == "ready") {
        return this.conn;
      }

      // tear down whatever is left of the previous connection; ending it
      // makes ssh2 fail its outstanding channels instead of leaking them
      const previous = this.conn;
      if (previous) {
        try {
          previous.end();
        } catch {}
      }

      const conn = this._createConnection();
      this.conn = conn;
      this.conn_state = "connecting";
      this.conn_err = undefined;

      try {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            conn.removeListener("ready", onReady);
            conn.removeListener("error", onError);
            conn.removeListener("close", onClose);
          };
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onError = (err) => {
            cleanup();
            reject(err);
          };
          const onClose = () => {
            cleanup();
            reject(new Error("ssh connection closed before ready"));
          };
          conn.once("ready", onReady);
          conn.once("error", onError);
          conn.once("close", onClose);
          try {
            conn.connect(this.options.connection);
          } catch (err) {
            cleanup();
            reject(err);
          }
        });
      } catch (err) {
        if (this.conn === conn) {
          this.conn_state = "error";
          this.conn_err = err;
        }
        try {
          conn.end();
        } catch {}
        throw err;
      }

      return conn;
    });
  }

  /**
   * Return a ready ssh2 Client, connecting if needed.
   */
  async connect() {
    if (this.conn && this.conn_state == "ready") {
      return this.conn;
    }

    return this._connect();
  }

  async exec(command, options = {}, stream_proxy = null) {
    // default is to reuse
    if (process.env.SSH_REUSE_CONNECTION == "0") {
      return this._nexec(...arguments);
    } else {
      return this._rexec(...arguments);
    }
  }

  /**
   * Max time in ms a single exec may run before it is rejected and its
   * channel closed. 0 disables the timeout.
   *
   * Order: options.execTimeoutMs, then the SSH_EXEC_TIMEOUT_MS env var, then
   * DEFAULT_EXEC_TIMEOUT_MS.
   */
  getExecTimeoutMs() {
    const fromOption = this.options.execTimeoutMs;
    if (Number.isInteger(fromOption) && fromOption >= 0) {
      return fromOption;
    }

    const fromEnv = process.env.SSH_EXEC_TIMEOUT_MS;
    if (fromEnv !== undefined && /^\d+$/.test(fromEnv)) {
      return parseInt(fromEnv, 10);
    }

    return DEFAULT_EXEC_TIMEOUT_MS;
  }

  /**
   * Wire an exec channel's output into stdout/stderr buffers and the
   * optional stream_proxy, and call done({stderr, stdout, code, signal})
   * when the channel closes. Nothing is forwarded once isSettled() is true.
   */
  _handleExecStream(stream, stream_proxy, isSettled, done) {
    const client = this;
    let stderr;
    let stdout;

    stream
      .on("close", function (code, signal) {
        client.debug(
          "Stream :: close :: code: " + code + ", signal: " + signal
        );
        if (isSettled()) {
          return;
        }
        done({ stderr, stdout, code, signal });
        if (stream_proxy) {
          stream_proxy.emit("close", ...arguments);
        }
      })
      .on("data", function (data) {
        client.debug("STDOUT: " + data);
        if (isSettled()) {
          return;
        }
        if (stream_proxy) {
          stream_proxy.stdout.emit("data", ...arguments);
        }
        if (stdout == undefined) {
          stdout = "";
        }
        stdout = stdout.concat(data);
      })
      .stderr.on("data", function (data) {
        client.debug("STDERR: " + data);
        if (isSettled()) {
          return;
        }
        if (stream_proxy) {
          stream_proxy.stderr.emit("data", ...arguments);
        }
        if (stderr == undefined) {
          stderr = "";
        }
        stderr = stderr.concat(data);
      });
  }

  _execTimeoutError(timeoutMs, command) {
    const err = new Error(
      `ssh exec timed out after ${timeoutMs}ms: ${command}`
    );
    err.code = "ETIMEDOUT";
    return err;
  }

  /**
   * exec over the shared connection.
   *
   * The returned promise settles exactly once: when the channel closes, when
   * the exec request fails, when the shared connection ends/closes while the
   * exec is in flight, or when the exec timeout fires (the channel is then
   * destroyed). The remote process may keep running after a timeout or a
   * dropped connection, as with any ssh session without a pty.
   */
  _rexec(command, options = {}, stream_proxy = null) {
    const client = this;
    const timeoutMs = this.getExecTimeoutMs();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      let conn;
      let stream;

      const onConnEnd = () =>
        settle(
          new Error(`ssh connection ended while exec in flight: ${command}`)
        );
      const onConnClose = () =>
        settle(
          new Error(`ssh connection closed while exec in flight: ${command}`)
        );
      const detachConn = () => {
        if (conn) {
          conn.removeListener("end", onConnEnd);
          conn.removeListener("close", onConnClose);
        }
      };
      const settle = (err, result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        detachConn();
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          settle(client._execTimeoutError(timeoutMs, command));
          if (stream) {
            try {
              stream.destroy();
            } catch {}
          }
        }, timeoutMs);
      }

      const onExec = (err, s) => {
        if (err) {
          settle(err);
          return;
        }
        stream = s;
        if (settled) {
          // timed out (or connection dropped) while the channel was opening
          try {
            s.destroy();
          } catch {}
          return;
        }

        if (stream_proxy) {
          stream_proxy.on("kill", () => {
            s.destroy();
          });
        }

        client._handleExecStream(
          s,
          stream_proxy,
          () => settled,
          (result) => settle(null, result)
        );
      };

      (async () => {
        while (!settled) {
          try {
            conn = await client.connect();
          } catch (err) {
            settle(err);
            return;
          }
          if (settled) {
            return;
          }

          conn.on("end", onConnEnd);
          conn.on("close", onConnClose);
          try {
            conn.exec(command, options, onExec);
            return;
          } catch (err) {
            detachConn();
            if (!(
              err &&
              err.message &&
              err.message.includes("Not connected")
            )) {
              settle(err);
              return;
            }
          }
          // conn_state said ready but the socket is no longer writable; mark
          // it dead so the next connect() replaces it, then retry (bounded by
          // the exec timeout)
          if (client.conn === conn && client.conn_state == "ready") {
            client.conn_state = "closed";
          }
          await GeneralUtils.sleep(1000);
        }
      })().catch((err) => settle(err));
    });
  }

  /**
   * exec over a dedicated connection that is closed afterwards.
   * Same settle-once and timeout semantics as _rexec.
   */
  _nexec(command, options = {}, stream_proxy = null) {
    const client = this;
    const timeoutMs = this.getExecTimeoutMs();

    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      let timer;

      const settle = (err, result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
        try {
          conn.end();
        } catch {}
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          settle(client._execTimeoutError(timeoutMs, command));
        }, timeoutMs);
      }

      conn
        .on("error", function (err) {
          client.debug("Client :: error");
          settle(err);
        })
        .on("close", function () {
          settle(
            new Error(`ssh connection closed before exec completed: ${command}`)
          );
        })
        .on("ready", function () {
          client.debug("Client :: ready");
          //options.pty = true;
          //options.env = {
          //  TERM: "",
          //};
          try {
            conn.exec(command, options, function (err, stream) {
              if (err) {
                settle(err);
                return;
              }
              if (settled) {
                return;
              }
              client._handleExecStream(
                stream,
                stream_proxy,
                () => settled,
                (result) => settle(null, result)
              );
            });
          } catch (err) {
            settle(err);
          }
        });

      try {
        conn.connect(client.options.connection);
      } catch (err) {
        settle(err);
      }

      if (stream_proxy) {
        stream_proxy.on("kill", () => {
          conn.end();
        });
      }
    });
  }
}

module.exports.SshClient = SshClient;
