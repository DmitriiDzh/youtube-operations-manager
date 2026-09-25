import { createDefaultLogger } from "@/lib/shared-logger";
import { createChangeDraftsCoreForProduction, isDomainError } from "@/lib/sync-gateway";
import { createChangeSetChannelStoreAdapter, createIdGenerator } from "./adapters/store";
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
    channelStore: createChangeSetChannelStoreAdapter(),
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
    idGenerator: createIdGenerator(),
    logger: createDefaultLogger(),
  });
}

export type ChangeSetCore = ReturnType<typeof createChangeSetCore>;
