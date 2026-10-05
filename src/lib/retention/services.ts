import { planDraftPurge, planWriteLogPurge } from "./planner";
import type {
  RetentionBatchFacts,
  RetentionChangeSetFacts,
  RetentionLedgerRowFacts,
  RetentionSweepResult,
} from "./contracts";
import { createDefaultLogger, type Logger } from "@/lib/shared-logger";

export type RetentionDependencies = {
  /** Everything the planner needs for one channel, read from the SQL projection. */
  source: {
    listChangeSets(channelId: string): Promise<RetentionChangeSetFacts[]>;
    listLedgerRows(channelId: string): Promise<RetentionLedgerRowFacts[]>;
    listBatches(channelId: string): Promise<RetentionBatchFacts[]>;
  };
  /** The one place a draft is really deleted (the Automerge document through the change-drafts core, then its SQL rows). */
  drafts: {
    purgeChangeSets(input: { channelId: string; changeSetIds: string[] }): Promise<{ changeSets: number; changes: number; provenance: number; purgedChangeSetIds: string[] }>;
  };
  writeLog: { deleteBatches(batchIds: string[]): Promise<number> };
  settings: { draftRetentionDays(): Promise<number>; writeLogRetentionDays(): Promise<number> };
  logger?: Logger;
};

/** Ledger rows in these states belong to a write that is running or whose outcome is unknown: its draft must not disappear under it. */
const IN_FLIGHT_ROW_STATUSES = new Set(["PENDING", "AWAITING_EXECUTION", "APPLYING", "UNKNOWN"]);

export class ManualDeleteRefusedError extends Error {
  constructor(
    readonly code: "change_set_not_found" | "change_set_in_use" | "change_set_delete_failed",
    message: string
  ) {
    super(message);
    this.name = "ManualDeleteRefusedError";
  }
}

export function createRetentionCore(deps: RetentionDependencies) {
  const logger = () => deps.logger ?? createDefaultLogger();

  return {
    /**
     * The user deletes one change set by hand (owner request 2026-10-04), whatever its status -- the age and status rules above only govern the automatic
     * sweep. Refused only while a real write that carries one of its changes is running or unresolved. Goes through the same purge as the sweep, so
     * the deletion reaches the other devices exactly like an automatic one.
     */
    async deleteChangeSet(input: { channelId: string; changeSetId: string }): Promise<{ changeSets: number; changes: number; provenance: number }> {
      const changeSets = await deps.source.listChangeSets(input.channelId);
      const set = changeSets.find((candidate) => candidate.id === input.changeSetId);
      if (!set) throw new ManualDeleteRefusedError("change_set_not_found", "Change set not found in this channel.");
      const changeIds = new Set(set.changes.map((change) => change.id));
      // Checked twice: a send that creates its batch between the first check and the purge would otherwise leave a live batch pointing at deleted
      // changes (it would fail closed with "change not found", but confusingly). Only this device's ledger is visible here; another device's
      // unfinished write on the same change fails closed the same way after the next merge.
      const assertNoWriteInFlight = async () => {
        const ledgerRows = await deps.source.listLedgerRows(input.channelId);
        const busy = ledgerRows.some(
          (row) => !row.batchDryRun && IN_FLIGHT_ROW_STATUSES.has(row.status) && row.changeIds.some((changeId) => changeIds.has(changeId))
        );
        if (busy) {
          throw new ManualDeleteRefusedError("change_set_in_use", "A write that includes this change set is running or unresolved. Wait for it to finish (or resolve it in Batches), then delete.");
        }
      };
      await assertNoWriteInFlight();
      await assertNoWriteInFlight();
      const purged = await deps.drafts.purgeChangeSets({ channelId: input.channelId, changeSetIds: [set.id] });
      // The purge reports what it really removed (document AND SQL rows); anything else must not look like success.
      if (!purged.purgedChangeSetIds.includes(set.id)) {
        throw new ManualDeleteRefusedError("change_set_delete_failed", "The change set could not be fully deleted. Try again; if it persists, check the server log.");
      }
      return { changeSets: purged.changeSets, changes: purged.changes, provenance: purged.provenance };
    },

    /** One sweep for one channel: settled drafts first, then the write log of batches nothing depends on any more. Safe to repeat. */
    async sweepChannel(channelId: string, now: Date = new Date()): Promise<RetentionSweepResult> {
      const [draftDays, logDays] = await Promise.all([deps.settings.draftRetentionDays(), deps.settings.writeLogRetentionDays()]);
      const result: RetentionSweepResult = { channelId, purgedChangeSets: 0, purgedChanges: 0, purgedProvenance: 0, purgedBatches: 0 };

      const [changeSets, ledgerRows] = await Promise.all([deps.source.listChangeSets(channelId), deps.source.listLedgerRows(channelId)]);
      const draftPlan = planDraftPurge(changeSets, ledgerRows, now, draftDays);
      let purgedIds: string[] = [];
      if (draftPlan.changeSetIds.length > 0) {
        const purged = await deps.drafts.purgeChangeSets({ channelId, changeSetIds: draftPlan.changeSetIds });
        purgedIds = purged.purgedChangeSetIds;
        result.purgedChangeSets = purged.changeSets;
        result.purgedChanges = purged.changes;
        result.purgedProvenance = purged.provenance;
      }

      // What counts as gone is what the purge reports (document AND SQL rows removed), not what was merely planned.
      const purgedSetIds = new Set(purgedIds);
      const survivingChangeIds = new Set<string>();
      for (const set of changeSets) {
        if (purgedSetIds.has(set.id)) continue;
        for (const change of set.changes) survivingChangeIds.add(change.id);
      }
      const logPlan = planWriteLogPurge(await deps.source.listBatches(channelId), survivingChangeIds, now, logDays);
      if (logPlan.batchIds.length > 0) result.purgedBatches = await deps.writeLog.deleteBatches(logPlan.batchIds);

      if (result.purgedChangeSets > 0 || result.purgedBatches > 0) {
        logger().info({ event: "retention.sweep.purged", context: { ...result } });
      }
      return result;
    },
  };
}

export type RetentionCore = ReturnType<typeof createRetentionCore>;
