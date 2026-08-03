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
   * Shell-escape a single argument (POSIX single-quote wrapping).
   * @param {*} arg
   */
  shellEscapeArg(arg) {
    return shellEscapeArg(arg);
  }

  /**
   * Build a command line from name + args, shell-escaping every token.
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
   * Zetabyte passes tokens raw, so buildCommand must shell-escape here.
   */
  spawn() {
    const command = this.buildCommand(arguments[0], arguments[1]);
    this.logger.verbose("LocalCliExecClient command: " + command);
    return cp.exec(command);
  }
}

module.exports.LocalCliClient = LocalCliExecClient;
