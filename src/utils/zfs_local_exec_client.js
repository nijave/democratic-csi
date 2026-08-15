const cp = require("child_process");

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
   * Shell-escape a single argument by wrapping it in single quotes and
   * safely terminating any embedded single quotes (the standard POSIX
   * '\'' idiom). The result is a single shell word whose literal value is
   * exactly `arg`, so no metacharacter it contains can be interpreted by the
   * local shell.
   *
   * @param {*} arg
   */
  shellEscapeArg(arg) {
    return `'${String(arg).replace(/'/g, `'\\''`)}'`;
  }

  /**
   * Build a command line from the name and given args, escaping every token
   * so request-controlled values (dataset/snapshot names) cannot inject
   * additional shell commands.
   *
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
   * This is the Zetabyte executor interface (zfs.js), whose callers escape
   * shell-sensitive tokens themselves (escapeShell() on property values, the
   * manually quoted `zfs send | zfs receive` pipeline) - the same contract
   * ZfsSshProcessManager.buildCommand provides over ssh. Escaping again here
   * would turn those pre-escaped tokens into literals, so join raw.
   */
  spawn() {
    const command = [arguments[0]].concat(arguments[1] || []).join(" ");
    this.logger.verbose("LocalCliExecClient command: " + command);
    return cp.exec(command);
  }
}

module.exports.LocalCliClient = LocalCliExecClient;
