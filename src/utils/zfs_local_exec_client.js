const cp = require("child_process");
const { shellEscapeArg } = require("./zfs");

class LocalCliExecClient {
  constructor(options = {}) {
    this.options = options;
    if (this.options.logger) {
      this.logger = this.options.logger;
    } else {
      this.logger = console;
    }
  }

  /**
   * Shell-escape a single argument (single-quote wrapping with the POSIX
   * '\'' idiom), so no metacharacter it contains can be interpreted by the
   * local shell spawned by cp.exec.
   *
   * @param {*} arg
   */
  shellEscapeArg(arg) {
    return shellEscapeArg(arg);
  }

  /**
   * Build a command line from the name and given args, escaping every token
   * so request/config-controlled values (dataset/snapshot names, property
   * values) cannot inject additional commands into the local shell.
   *
   * @param {*} name
   * @param {*} args
   */
  buildCommand(name, args = []) {
    args.unshift(name);
    return args.map((arg) => shellEscapeArg(arg)).join(" ");
  }

  debug() {
    this.logger.silly(...arguments);
  }

  async exec(command, options = {}) {
    return new Promise((resolve, reject) => {
      this.logger.verbose("LocalCliExecClient command: " + command);
      let process = cp.exec(command, (err, stdout, stderr) => {
        if (err) {
          reject(err);
        }
        resolve({
          stderr,
          stdout,
          code: process.exitCode,
          signal: process.exitSignal,
        });
      });
    });
  }

  /**
   * simple wrapper for logging
   *
   * This is the Zetabyte executor interface (zfs.js). Zetabyte passes every
   * token raw (it no longer pre-escapes property values or the
   * `zfs send | zfs receive` pipeline payload), so escaping must happen here
   * before cp.exec hands the string to a shell - the same contract
   * ZfsSshProcessManager.buildCommand provides over ssh.
   */
  spawn() {
    const command = this.buildCommand(arguments[0], arguments[1]);
    this.logger.verbose("LocalCliExecClient command: " + command);
    return cp.exec(command);
  }
}

module.exports.LocalCliClient = LocalCliExecClient;
