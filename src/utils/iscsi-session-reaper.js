const fs = require("fs");

/**
 * iSCSI stale-session reaper: reaps sessions whose backing target is gone (all
 * attached devices offline/transport-offline and unmounted). open-iscsi does
 * not self-reap such sessions; the node-DB record persists until an explicit
 * `iscsiadm -m node --logout` (+ `-o delete`).
 */

// SCSI device states (from /sys/block/<dev>/device/state) meaning the backing
// device is gone; any other state (e.g. "running", "blocked") blocks reaping.
const STALE_DEVICE_STATES = ["offline", "transport-offline"];

// iscsiadm exec rejections are plain objects (see ISCSI.exec), not Errors, so
// they have no .stack; assemble the exec detail when a stack is absent.
function formatError(err) {
  if (err && err.stack) {
    return err.stack;
  }
  if (err && typeof err === "object") {
    const parts = [];
    if (err.code !== undefined && err.code !== null) {
      parts.push(`code=${err.code}`);
    }
    if (err.timeout) {
      parts.push("timeout=true");
    }
    if (err.stderr) {
      parts.push(`stderr=${String(err.stderr).trim()}`);
    }
    if (err.stdout) {
      parts.push(`stdout=${String(err.stdout).trim()}`);
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Return the attached SCSI devices for a session as parsed by
 * iscsi.iscsiadm.getSessionsDetails().
 */
function sessionDevices(session) {
  return (
    (session &&
      session.attached_scsi_devices &&
      session.attached_scsi_devices.host &&
      session.attached_scsi_devices.host.devices) ||
    []
  );
}

/**
 * Reapable only when every attached SCSI device is offline/transport-offline
 * and unmounted; any running/mounted/unknown device makes it non-reapable.
 *
 * @param {*} session session object from getSessionsDetails()
 * @param {*} ctx
 * @param {Object} ctx.deviceStates map of device name -> state; falls back to
 *        the session detail's state when absent.
 * @param {Object} ctx.mounts map of device name -> mounted; absent = mounted.
 * @returns {{reapable: boolean, reason: string, devices: Array}}
 */
function isSessionReapable(session, { deviceStates = {}, mounts = {} } = {}) {
  const devices = sessionDevices(session);

  if (devices.length === 0) {
    return {
      reapable: false,
      reason: "session has no attached scsi devices (cannot confirm stale)",
      devices: [],
    };
  }

  const summaries = [];
  let allStale = true;

  for (const device of devices) {
    const dev = device.attached_scsi_disk; // e.g. "sdb"

    if (!dev) {
      allStale = false;
      summaries.push({ dev: null, state: null, mounted: null });
      continue;
    }

    let state = deviceStates[dev];
    if (state === undefined || state === null) {
      // fall back to the state parsed out of `iscsiadm -m session -P 3`
      state = device.state;
    }
    state = String(state || "")
      .trim()
      .toLowerCase();

    let mounted = mounts[dev];
    if (mounted === undefined) {
      // unknown mount status -> assume in-use
      mounted = true;
    }

    summaries.push({ dev, state, mounted });

    if (mounted) {
      allStale = false;
    }
    if (!STALE_DEVICE_STATES.includes(state)) {
      allStale = false;
    }
  }

  if (allStale) {
    return {
      reapable: true,
      reason: "all attached devices offline/transport-offline and unmounted",
      devices: summaries,
    };
  }

  return {
    reapable: false,
    reason: "session has running and/or mounted device(s)",
    devices: summaries,
  };
}

/**
 * Read the SCSI device state from sysfs; lowercased, or null if unreadable.
 *
 * @param {*} dev short device name, e.g. "sdb"
 */
async function readDeviceStateFromSysfs(dev) {
  if (!dev) {
    return null;
  }
  try {
    const raw = await fs.promises.readFile(
      `/sys/block/${dev}/device/state`,
      "utf8"
    );
    return raw.trim().toLowerCase();
  } catch (err) {
    return null;
  }
}

/**
 * Gather device-state and mount maps for a session. Sysfs is authoritative;
 * the session detail's state is used as a fallback in isSessionReapable.
 */
async function collectSessionDeviceInfo(session, { readDeviceState, mount }) {
  const deviceStates = {};
  const mounts = {};

  for (const device of sessionDevices(session)) {
    const dev = device.attached_scsi_disk;
    if (!dev) {
      continue;
    }

    const state = await readDeviceState(dev);
    if (state !== null && state !== undefined) {
      deviceStates[dev] = state;
    }

    try {
      mounts[dev] = await mount.deviceIsMounted(`/dev/${dev}`);
    } catch (err) {
      // could not determine -> treat as in-use
      mounts[dev] = true;
    }
  }

  return { deviceStates, mounts };
}

/**
 * Log out of and delete the node-DB entry for a stale session. Tolerates
 * "already gone". Returns true only when the logout itself succeeded.
 */
async function reapSession({ iscsi, logger, iqn, portal }) {
  let ok = true;

  try {
    // iscsiadm.logout already swallows "no matching sessions" (code 21)
    await iscsi.iscsiadm.logout(iqn, [portal]);
    logger.info(
      "iscsi session reaper: logged out of session %s %s",
      iqn,
      portal
    );
  } catch (err) {
    ok = false;
    logger.error(
      "iscsi session reaper: failed logout of session %s %s: %s",
      iqn,
      portal,
      formatError(err)
    );
  }

  try {
    await iscsi.iscsiadm.deleteNodeDBEntry(iqn, portal);
    logger.info(
      "iscsi session reaper: deleted node DB entry %s %s",
      iqn,
      portal
    );
  } catch (err) {
    logger.warn(
      "iscsi session reaper: failed deleting node DB entry %s %s (may already be gone): %s",
      iqn,
      portal,
      formatError(err)
    );
  }

  return ok;
}

/**
 * Run a single reconcile pass.
 *
 * @param {Object} deps
 * @param {*} deps.iscsi ISCSI instance (getSessionsDetails/logout/deleteNodeDBEntry)
 * @param {*} deps.mount Mount instance (deviceIsMounted)
 * @param {*} deps.logger logger
 * @param {Object} deps.config { enabled, minStaleSeconds }
 * @param {Map} deps.staleSince cross-pass map: `${iqn}|${portal}` -> epoch secs
 * @param {number} [deps.now] epoch seconds (injectable for tests)
 * @param {function} [deps.readDeviceState] async (dev) => state|null
 * @returns {Promise<{disabled?: boolean, candidates: Array, reaped: Array,
 *   failed: Array, skipped: Array}>}
 */
async function reconcile({
  iscsi,
  mount,
  logger,
  config = {},
  staleSince,
  now,
  readDeviceState = readDeviceStateFromSysfs,
}) {
  const summary = {
    candidates: [],
    reaped: [],
    failed: [],
    skipped: [],
  };

  if (!config.enabled) {
    return Object.assign({ disabled: true }, summary);
  }

  const minStaleSeconds =
    config.minStaleSeconds === undefined ? 120 : Number(config.minStaleSeconds);
  const nowSeconds =
    now === undefined ? Math.round(Date.now() / 1000) : Number(now);

  if (!(staleSince instanceof Map)) {
    staleSince = new Map();
  }

  let sessions;
  try {
    sessions = await iscsi.iscsiadm.getSessionsDetails();
  } catch (err) {
    logger.error(
      "iscsi session reaper: failed to enumerate sessions: %s",
      formatError(err)
    );
    return summary;
  }

  if (!Array.isArray(sessions) || sessions.length === 0) {
    staleSince.clear();
    return summary;
  }

  const currentCandidateKeys = new Set();

  for (const session of sessions) {
    const iqn = session.target;
    const portal = session.persistent_portal || session.current_portal;

    if (!iqn || !portal) {
      logger.debug(
        "iscsi session reaper: skipping session missing iqn/portal: %j",
        { iqn, portal }
      );
      continue;
    }

    const key = `${iqn}|${portal}`;

    let evaluation;
    try {
      const { deviceStates, mounts } = await collectSessionDeviceInfo(session, {
        readDeviceState,
        mount,
      });
      evaluation = isSessionReapable(session, { deviceStates, mounts });
    } catch (err) {
      // never treat a session we could not fully evaluate as reapable
      logger.error(
        "iscsi session reaper: failed evaluating session %s %s: %s",
        iqn,
        portal,
        formatError(err)
      );
      continue;
    }

    if (!evaluation.reapable) {
      staleSince.delete(key);
      summary.skipped.push({ iqn, portal, reason: evaluation.reason });
      continue;
    }

    currentCandidateKeys.add(key);
    summary.candidates.push({ iqn, portal, devices: evaluation.devices });

    let firstSeen = staleSince.get(key);
    if (firstSeen === undefined) {
      firstSeen = nowSeconds;
      staleSince.set(key, firstSeen);
    }

    const staleFor = nowSeconds - firstSeen;
    if (staleFor < minStaleSeconds) {
      logger.info(
        "iscsi session reaper: observed stale session %s %s (%s); stale for %ss, waiting for %ss. devices=%j",
        iqn,
        portal,
        evaluation.reason,
        staleFor,
        minStaleSeconds,
        evaluation.devices
      );
      continue;
    }

    logger.info(
      "iscsi session reaper: reaping stale session %s %s (stale for %ss; %s). devices=%j",
      iqn,
      portal,
      staleFor,
      evaluation.reason,
      evaluation.devices
    );

    const reaped = await reapSession({ iscsi, logger, iqn, portal });
    if (reaped) {
      staleSince.delete(key);
      currentCandidateKeys.delete(key);
      summary.reaped.push({ iqn, portal });
    } else {
      // logout failed: keep the staleness timer and do not count as reaped
      summary.failed.push({ iqn, portal });
    }
  }

  // drop tracking for sessions that are no longer candidates
  for (const trackedKey of Array.from(staleSince.keys())) {
    if (!currentCandidateKeys.has(trackedKey)) {
      staleSince.delete(trackedKey);
    }
  }

  return summary;
}

/**
 * Runtime wrapper owning the timers and the cross-pass staleness map.
 */
class ISCSISessionReaper {
  constructor(options = {}) {
    const reaper = this;
    reaper.options = options;

    if (!options.logger) {
      throw new Error("ISCSISessionReaper requires a logger");
    }
    if (!options.iscsi) {
      throw new Error("ISCSISessionReaper requires an iscsi instance");
    }
    if (!options.mount) {
      throw new Error("ISCSISessionReaper requires a mount instance");
    }

    reaper.logger = options.logger;
    reaper.iscsi = options.iscsi;
    reaper.mount = options.mount;

    reaper.enabled = options.enabled === undefined ? false : !!options.enabled;
    reaper.intervalSeconds = Number(options.intervalSeconds) || 300;
    reaper.minStaleSeconds =
      options.minStaleSeconds === undefined
        ? 120
        : Number(options.minStaleSeconds);
    reaper.startupDelaySeconds =
      options.startupDelaySeconds === undefined
        ? 60
        : Number(options.startupDelaySeconds);

    // key (`${iqn}|${portal}`) -> epoch seconds when first observed fully stale
    reaper.staleSince = new Map();

    reaper._timer = null;
    reaper._startupTimer = null;
    reaper._running = false;
    reaper._started = false;
  }

  /**
   * Begin the periodic reconcile loop. Idempotent; first pass after
   * startupDelaySeconds.
   */
  start() {
    const reaper = this;
    if (!reaper.enabled) {
      return;
    }
    if (reaper._started) {
      return;
    }
    reaper._started = true;

    reaper.logger.info(
      "iscsi session reaper: starting (intervalSeconds=%s, minStaleSeconds=%s, startupDelaySeconds=%s)",
      reaper.intervalSeconds,
      reaper.minStaleSeconds,
      reaper.startupDelaySeconds
    );

    const scheduleInterval = () => {
      reaper._timer = setInterval(() => {
        reaper.runOnce().catch((err) => {
          reaper.logger.error(
            "iscsi session reaper: unexpected error during pass: %s",
            formatError(err)
          );
        });
      }, reaper.intervalSeconds * 1000);
      if (reaper._timer && typeof reaper._timer.unref === "function") {
        reaper._timer.unref();
      }
    };

    reaper._startupTimer = setTimeout(() => {
      reaper
        .runOnce()
        .catch((err) => {
          reaper.logger.error(
            "iscsi session reaper: unexpected error during startup pass: %s",
            formatError(err)
          );
        })
        .finally(() => {
          scheduleInterval();
        });
    }, reaper.startupDelaySeconds * 1000);
    if (
      reaper._startupTimer &&
      typeof reaper._startupTimer.unref === "function"
    ) {
      reaper._startupTimer.unref();
    }
  }

  /**
   * Stop the loop (used for clean shutdown / tests).
   */
  stop() {
    const reaper = this;
    if (reaper._timer) {
      clearInterval(reaper._timer);
      reaper._timer = null;
    }
    if (reaper._startupTimer) {
      clearTimeout(reaper._startupTimer);
      reaper._startupTimer = null;
    }
    reaper._started = false;
  }

  /**
   * Run a single reconcile pass. Guarded so passes never overlap.
   */
  async runOnce() {
    const reaper = this;
    if (reaper._running) {
      reaper.logger.debug(
        "iscsi session reaper: previous pass still running, skipping this tick"
      );
      return;
    }
    reaper._running = true;
    try {
      return await reconcile({
        iscsi: reaper.iscsi,
        mount: reaper.mount,
        logger: reaper.logger,
        config: {
          enabled: reaper.enabled,
          minStaleSeconds: reaper.minStaleSeconds,
        },
        staleSince: reaper.staleSince,
      });
    } finally {
      reaper._running = false;
    }
  }
}

module.exports.ISCSISessionReaper = ISCSISessionReaper;
module.exports.isSessionReapable = isSessionReapable;
module.exports.reconcile = reconcile;
module.exports.reapSession = reapSession;
module.exports.readDeviceStateFromSysfs = readDeviceStateFromSysfs;
module.exports.formatError = formatError;
module.exports.STALE_DEVICE_STATES = STALE_DEVICE_STATES;
