// Default ceiling on how long one request may hold its operation lock keys.
// It is twice the default ssh exec timeout (SSH_EXEC_TIMEOUT_MS), so a
// handler whose execs all time out normally releases its keys first.
const DEFAULT_MAX_HOLD_MS = 30 * 60 * 1000;

/**
 * In-memory per-key operation lock for CSI requests.
 *
 * acquire() is an atomic check-and-set over all keys of a request. Each
 * acquisition gets a unique token, and release(token) only removes keys
 * that the same acquisition still holds.
 *
 * A key held longer than maxHoldMs is treated as stale: the next request
 * for that key evicts it and proceeds. The original handler may still be
 * running at that point, so this is a last-resort guard against a handler
 * that never returns (which otherwise blocks the volume until the process
 * restarts). Because release() is token-checked, the stale handler cannot
 * release a lock that a later request now holds. maxHoldMs of 0 disables
 * eviction.
 */
class OperationLock {
  constructor(options = {}) {
    this.logger = options.logger;
    this.now = options.now || (() => Date.now());
    this.maxHoldMs = OperationLock.resolveMaxHoldMs(options.maxHoldMs);
    this.held = new Map();
    this.nextToken = 1;
  }

  /**
   * options value, then the OPERATION_LOCK_MAX_HOLD_MS env var, then the
   * default.
   */
  static resolveMaxHoldMs(value) {
    if (Number.isInteger(value) && value >= 0) {
      return value;
    }

    const fromEnv = process.env.OPERATION_LOCK_MAX_HOLD_MS;
    if (fromEnv !== undefined && /^\d+$/.test(fromEnv)) {
      return parseInt(fromEnv, 10);
    }

    return DEFAULT_MAX_HOLD_MS;
  }

  isStale(entry, now) {
    return this.maxHoldMs > 0 && now - entry.acquiredAt >= this.maxHoldMs;
  }

  /**
   * Acquire all keys or none.
   *
   * @param {string[]} keys
   * @param {string} [operation] label used in logs
   * @returns {number|null} a token for release(), or null if any key is held
   */
  acquire(keys, operation) {
    const now = this.now();

    for (const key of keys) {
      const entry = this.held.get(key);
      if (entry && !this.isStale(entry, now)) {
        return null;
      }
    }

    for (const key of keys) {
      const entry = this.held.get(key);
      if (entry) {
        if (this.logger) {
          this.logger.warn(
            "evicting stale operation lock %s held for %dms by %s (max hold %dms); the earlier handler may still be running",
            key,
            now - entry.acquiredAt,
            entry.operation,
            this.maxHoldMs
          );
        }
        this.held.delete(key);
      }
    }

    const token = this.nextToken++;
    for (const key of keys) {
      this.held.set(key, { token, acquiredAt: now, operation });
    }
    return token;
  }

  /**
   * Release the keys still held by the acquisition that returned token.
   */
  release(keys, token) {
    for (const key of keys) {
      const entry = this.held.get(key);
      if (entry && entry.token === token) {
        this.held.delete(key);
      }
    }
  }

  has(key) {
    return this.held.has(key);
  }
}

module.exports.OperationLock = OperationLock;
module.exports.DEFAULT_MAX_HOLD_MS = DEFAULT_MAX_HOLD_MS;
