/**
 * iSCSI node-DB orphan sweeper
 *
 * Node-side, opt-in startup backstop that deletes node-DB records whose
 * target has no active session.
 *
 * Why this is needed: a node-DB record is created by NodeStageVolume and
 * deleted by NodeUnstageVolume, and nothing else ever removes it. When a
 * volume's PV goes away without its unstage running -- driver pod restart
 * mid-unstage, node reboot with volumes staged, or an unstage that failed
 * during an iscsiadm lock convoy -- the record is orphaned permanently:
 * kubelet never calls NodeUnstageVolume for a volume that no longer
 * exists. Orphans are not merely cosmetic: open-iscsi enumerates every
 * record while holding its exclusive node-DB lock, so accumulated orphans
 * lengthen the critical section of every subsequent iscsiadm operation
 * and widen lock contention under stage/unstage bursts (vmubtkube-a24
 * accumulated 189 orphans over a week of wedge events before this was
 * written).
 *
 * Design constraints (mirrors the session reaper): conservative and
 * opt-in.
 *   - Runs ONCE at node-driver startup, after startupDelaySeconds.
 *   - Deletes a record ONLY if NO active session exists for its target
 *     IQN (any portal). A staged volume always has a live session, and a
 *     record for a volume that is about to stage is harmlessly recreated
 *     by NodeStageVolume (`-o new` + attribute updates are idempotent).
 *   - When targetBasename is configured, only targets whose IQN starts
 *     with it are considered; foreign targets are left untouched.
 *   - Immediately before each delete the record is re-verified with fresh
 *     iscsiadm queries: it must still exist and its IQN must still have no
 *     session. NodeStageVolume creates the node-DB record (`-o new` + CHAP
 *     attributes) BEFORE it logs in, and the sweep runs outside the
 *     per-volume operation lock, so a record that looked orphaned in the
 *     initial snapshot may belong to a stage in flight; the re-check
 *     shrinks that exposure from the whole sweep duration to the gap
 *     between the re-check and the delete. (Closing it completely would
 *     need an atomic check+delete holding the shared iscsiadm exec mutex
 *     across both commands -- an iscsi.js API change left as follow-up.)
 *   - Every delete and every re-check skip is logged. Per-record failures
 *     are logged and skipped; a single failure never aborts the sweep.
 *
 * The candidate-selection predicate is a pure, dependency-injected
 * function so it can be unit tested without a real iscsiadm/host. The
 * ISCSINodeDbSweeper class is a thin runtime wrapper owning the timer.
 */

/**
 * Select the node-DB records that are safe to delete: no active session
 * for the target IQN, and (when configured) an IQN matching the driver's
 * basename.
 *
 * @param {Array<{portal: string, iqn: string}>} records
 * @param {Array<{iqn: string}>} sessions
 * @param {string|null} targetBasename  when set, only IQNs with this
 *   prefix are eligible
 * @returns {Array<{portal: string, iqn: string}>}
 */
function selectOrphanedRecords(records, sessions, targetBasename = null) {
  const sessionIqns = new Set(sessions.map((session) => session.iqn));
  return records.filter((record) => {
    if (!record.iqn) {
      return false;
    }
    if (targetBasename && !record.iqn.startsWith(targetBasename)) {
      return false;
    }
    return !sessionIqns.has(record.iqn);
  });
}

class ISCSINodeDbSweeper {
  constructor(options = {}) {
    const sweeper = this;
    sweeper.options = options;
    sweeper.iscsi = options.iscsi;
    sweeper.logger = options.logger || console;
    sweeper.startupDelaySeconds = options.startupDelaySeconds || 60;
    sweeper.targetBasename = options.targetBasename || null;
    sweeper.timer = null;
  }

  start() {
    const sweeper = this;
    // one-shot: run after a delay so driver/kubelet startup (and any
    // immediate re-staging after a node reboot) settles first
    sweeper.timer = setTimeout(() => {
      sweeper.timer = null;
      sweeper.sweep().catch((err) => {
        sweeper.logger.error(
          "iscsi node-db sweep failed: %s",
          err && err.stack ? err.stack : String(err)
        );
      });
    }, sweeper.startupDelaySeconds * 1000);
    if (sweeper.timer.unref) {
      sweeper.timer.unref();
    }
  }

  stop() {
    const sweeper = this;
    if (sweeper.timer) {
      clearTimeout(sweeper.timer);
      sweeper.timer = null;
    }
  }

  async sweep() {
    const sweeper = this;

    const records = await sweeper.iscsi.iscsiadm.listNodeDBEntries();
    if (records.length === 0) {
      sweeper.logger.info("iscsi node-db sweep: no records present");
      return;
    }

    const sessions = await sweeper.iscsi.iscsiadm.getSessions();
    const orphans = selectOrphanedRecords(
      records,
      sessions,
      sweeper.targetBasename
    );

    if (orphans.length === 0) {
      sweeper.logger.info(
        "iscsi node-db sweep: %d record(s), all in use",
        records.length
      );
      return;
    }

    sweeper.logger.info(
      "iscsi node-db sweep: %d record(s), %d orphaned (no session) -- deleting",
      records.length,
      orphans.length
    );

    for (const record of orphans) {
      try {
        // Re-verify with fresh iscsiadm queries immediately before the
        // delete: the snapshot above may be arbitrarily stale by now, and
        // NodeStageVolume creates the node-DB record before logging in, so
        // a "no session" classification from the snapshot can describe a
        // stage that is in flight right now.
        const exists = await sweeper.iscsi.iscsiadm.nodeDBEntryExists(
          record.iqn,
          record.portal
        );
        if (!exists) {
          sweeper.logger.info(
            "iscsi node-db sweep: skipping %s %s: record no longer exists",
            record.portal,
            record.iqn
          );
          continue;
        }

        // Session re-check last so it sits closest to the delete: a login
        // completing between the snapshot and here is the dangerous flip.
        const currentSessions = await sweeper.iscsi.iscsiadm.getSessions();
        if (currentSessions.some((session) => session.iqn === record.iqn)) {
          sweeper.logger.info(
            "iscsi node-db sweep: skipping %s %s: session appeared since snapshot",
            record.portal,
            record.iqn
          );
          continue;
        }

        await sweeper.iscsi.iscsiadm.deleteNodeDBEntry(
          record.iqn,
          record.portal
        );
        sweeper.logger.info(
          "iscsi node-db sweep: deleted %s %s",
          record.portal,
          record.iqn
        );
      } catch (err) {
        sweeper.logger.error(
          "iscsi node-db sweep: failed deleting %s %s: %s",
          record.portal,
          record.iqn,
          err && err.stderr ? String(err.stderr).trim() : String(err)
        );
      }
    }
  }
}

module.exports = {
  ISCSINodeDbSweeper,
  selectOrphanedRecords,
};
