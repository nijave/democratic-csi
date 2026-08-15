/**
 * iSCSI node-DB orphan sweeper
 *
 * Opt-in, node-side startup backstop that deletes node-DB records whose target
 * has no active session. A record is created by NodeStageVolume and removed by
 * NodeUnstageVolume; when unstage never runs (pod restart, node reboot) the
 * record is orphaned permanently. Runs once at startup after startupDelaySeconds
 * and only deletes records with no active session, re-verified immediately
 * before each delete. When targetBasename is set, only matching IQNs are
 * considered. A single per-record failure never aborts the sweep.
 */

/**
 * Select node-DB records safe to delete: no active session and (when set) IQN matching targetBasename.
 *
 * @param {Array<{portal: string, iqn: string}>} records
 * @param {Array<{iqn: string}>} sessions
 * @param {string|null} targetBasename  when set, only IQNs with this prefix are eligible
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
    // one-shot: delay so driver/kubelet startup completes first
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
        // re-verify immediately before delete; the snapshot may be stale
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

        // session re-check last, closest to the delete
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
