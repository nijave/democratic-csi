const Client = require("ssh2").Client;
const { Mutex } = require("async-mutex");
const GeneralUtils = require("./general");

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

  async _rexec(command, options = {}, stream_proxy = null) {
    const client = this;

    // pre-existing async promise executor; left as-is to avoid behavior change
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      do {
        try {
          const conn = await this.connect();
          conn.exec(command, options, function (err, stream) {
            if (err) {
              reject(err);
              return;
            }
            let stderr;
            let stdout;

            if (stream_proxy) {
              stream_proxy.on("kill", (signal) => {
                stream.destroy();
              });
            }

            stream
              .on("close", function (code, signal) {
                client.debug(
                  "Stream :: close :: code: " + code + ", signal: " + signal
                );
                if (stream_proxy) {
                  stream_proxy.emit("close", ...arguments);
                }
                resolve({ stderr, stdout, code, signal });
                //conn.end();
              })
              .on("data", function (data) {
                client.debug("STDOUT: " + data);
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
                if (stream_proxy) {
                  stream_proxy.stderr.emit("data", ...arguments);
                }
                if (stderr == undefined) {
                  stderr = "";
                }
                stderr = stderr.concat(data);
              });
          });
          break;
        } catch (err) {
          if (err.message && !err.message.includes("Not connected")) {
            throw err;
          }
        }
        await GeneralUtils.sleep(1000);
      } while (true);
    });
  }

  async _nexec(command, options = {}, stream_proxy = null) {
    const client = this;
    return new Promise((resolve, reject) => {
      var conn = new Client();

      conn
        .on("error", function (err) {
          client.debug("Client :: error");
          reject(err);
        })
        .on("ready", function () {
          client.debug("Client :: ready");
          //options.pty = true;
          //options.env = {
          //  TERM: "",
          //};
          conn.exec(command, options, function (err, stream) {
            if (err) {
              reject(err);
              return;
            }
            let stderr;
            let stdout;
            stream
              .on("close", function (code, signal) {
                client.debug(
                  "Stream :: close :: code: " + code + ", signal: " + signal
                );
                if (stream_proxy) {
                  stream_proxy.emit("close", ...arguments);
                }
                resolve({ stderr, stdout, code, signal });
                conn.end();
              })
              .on("data", function (data) {
                client.debug("STDOUT: " + data);
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
                if (stream_proxy) {
                  stream_proxy.stderr.emit("data", ...arguments);
                }
                if (stderr == undefined) {
                  stderr = "";
                }
                stderr = stderr.concat(data);
              });
          });
        })
        .connect(client.options.connection);

      if (stream_proxy) {
        stream_proxy.on("kill", (signal) => {
          conn.end();
        });
      }
    });
  }
}

module.exports.SshClient = SshClient;
