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
    purgeChangeSets(input: { channelId: string; changeSetIds: string[] }): Promise<{ changeSets: number; changes: number; provenance: number }>;
  };
  writeLog: { deleteBatches(batchIds: string[]): Promise<number> };
  settings: { draftRetentionDays(): Promise<number>; writeLogRetentionDays(): Promise<number> };
  logger?: Logger;
};

export function createRetentionCore(deps: RetentionDependencies) {
  const logger = () => deps.logger ?? createDefaultLogger();

  return {
    /** One sweep for one channel: settled drafts first, then the write log of batches nothing depends on any more. Safe to repeat. */
    async sweepChannel(channelId: string, now: Date = new Date()): Promise<RetentionSweepResult> {
      const [draftDays, logDays] = await Promise.all([deps.settings.draftRetentionDays(), deps.settings.writeLogRetentionDays()]);
      const result: RetentionSweepResult = { channelId, purgedChangeSets: 0, purgedChanges: 0, purgedProvenance: 0, purgedBatches: 0 };

      const [changeSets, ledgerRows] = await Promise.all([deps.source.listChangeSets(channelId), deps.source.listLedgerRows(channelId)]);
      const draftPlan = planDraftPurge(changeSets, ledgerRows, now, draftDays);
      if (draftPlan.changeSetIds.length > 0) {
        const purged = await deps.drafts.purgeChangeSets({ channelId, changeSetIds: draftPlan.changeSetIds });
        result.purgedChangeSets = purged.changeSets;
        result.purgedChanges = purged.changes;
        result.purgedProvenance = purged.provenance;
      }

      const purgedSetIds = new Set(draftPlan.changeSetIds);
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
