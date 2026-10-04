import { listStoredChannels, rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createChangeDraftsCoreForProduction } from "@/lib/sync-gateway";
import { createSqlRetentionSource } from "./adapters/source";
import { createRetentionCore } from "./services";
import { createDefaultLogger } from "@/lib/shared-logger";

export function createRetentionCoreForProduction() {
  const changeDrafts = createChangeDraftsCoreForProduction();
  return createRetentionCore({
    ...createSqlRetentionSource(),
    drafts: { purgeChangeSets: (input) => changeDrafts.purgeChangeSets(input) },
  });
}

/** Scheduled sweep (`src/instrumentation.ts`): every connected channel, one at a time; a failing channel is logged and does not stop the others.
 * Skips quietly while the device may not mutate (operation lock / recovery mode); the next run tries again. */
export async function sweepSettledWork(now: Date = new Date()) {
  try {
    await assertDeviceAvailableForMutation(rawSqlClient);
  } catch {
    return [];
  }
  const core = createRetentionCoreForProduction();
  const results = [];
  for (const channel of await listStoredChannels()) {
    try {
      results.push(await core.sweepChannel(channel.channelId, now));
    } catch (error) {
      createDefaultLogger().error({
        event: "retention.sweep.failed",
        context: { channelId: channel.channelId, cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return results;
}

export type { RetentionCore } from "./services";
export { createRetentionCore, ManualDeleteRefusedError } from "./services";
export { planDraftPurge, planWriteLogPurge } from "./planner";
export type * from "./contracts";
