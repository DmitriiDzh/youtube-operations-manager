import { createDefaultLogger } from "@/lib/shared-logger";
import { createChangeDraftsCoreForProduction, isDomainError } from "@/lib/sync-gateway";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { getChannelExpectedLanguages } from "@/lib/db";
import { createIdGenerator } from "./adapters/store";
import { createAutomergeBackedChangeSetStoreAdapter } from "./adapters/change-drafts-store";
import { createChangeSetServices } from "./services";

// Cutover, 2026-09-21 (AUTOMERGE_MIGRATION_PLAN.md §6 CD2, docs/decisions/0006-*.md): writes now
// go through src/lib/change-drafts/ (Automerge) instead of directly to SQL -- this is the single
// place that changes. `createChangeSetServices` itself, and every one of its callers (API routes,
// MCP tools, CLI commands), is completely unaffected; they only ever depended on the adapter's
// interface, never on how it's implemented underneath.
export function createChangeSetCore() {
  const changeDrafts = createChangeDraftsCoreForProduction();

  return createChangeSetServices({
    channelStore: createChannelVideoStoreAdapter(),
    changeSetStore: createAutomergeBackedChangeSetStoreAdapter(),
    // RISK-47 (docs/TECHNICAL_DEBT.md): approve must refuse a change with an open CRDT field
    // conflict, not just this module's own `conflictStatus`. A channel with no Automerge document
    // at all yet (`not_found`) genuinely has zero conflicts, not an error.
    crdtConflicts: {
      async listConflictedChangeIds(channelId: string): Promise<Set<string>> {
        try {
          const conflicts = await changeDrafts.listConflicts({ channelId });
          return new Set(conflicts.map((c) => c.changeId));
        } catch (error) {
          if (isDomainError(error) && error.code === "not_found") return new Set();
          throw error;
        }
      },
    },
    // BL-178 (PROJECT_SPEC §14, 2026-10-12): rows are compared with the video read against the channel's language baseline.
    channelLanguageBaseline: { getExpectedDefaultLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultLanguage },
    idGenerator: createIdGenerator(),
    logger: createDefaultLogger(),
  });
}

export type ChangeSetCore = ReturnType<typeof createChangeSetCore>;

// BL-198: the synced-copy reading the send service uses to tell a change already on YouTube.
export { readWithChannelBaseline, remoteHoldsApprovedValue } from "./diff";
